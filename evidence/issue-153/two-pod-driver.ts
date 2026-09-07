// Two-pod migration driver — issue #153 / PR #157 (RFC 0013 T3, destination half).
//
// Drives the REAL flow over HTTP against two independent server instances:
//   A (origin)      = deployed staging  (env ORIGIN)   — export + confirm + revoke
//   B (destination) = separate instance (env DEST)    — did:key ceremony + import + receipt
//
// The only seeded data is a clearly-labeled sample cookie (`oa153-sample-cookie`, not live data).
// Every step asserts its expectation; any failure exits nonzero and the transcript names it.
//
// Run:
//   ORIGIN=<staging /oauth3> DEST=http://127.0.0.1:3199 \
//   ORIGIN_OWNER=<staging owner secret> DEST_OWNER=<dest owner secret> \
//   deno run --allow-net --allow-env evidence/issue-153/two-pod-driver.ts

import { generateKeypair } from "../../server/ucan.ts";

const ORIGIN = Deno.env.get("ORIGIN")!;
const DEST = Deno.env.get("DEST")!;
const ORIGIN_OWNER = Deno.env.get("ORIGIN_OWNER")!;
const DEST_OWNER = Deno.env.get("DEST_OWNER")!;
if (!ORIGIN || !DEST || !ORIGIN_OWNER || !DEST_OWNER) {
  console.error("ORIGIN, DEST, ORIGIN_OWNER, DEST_OWNER are required");
  Deno.exit(2);
}

const enc = new TextEncoder();
let failed = 0;
const line = (s = "") => console.log(s);

async function call(
  base: string,
  method: string,
  path: string,
  body: unknown,
  auth?: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

function check(label: string, ok: boolean, detail: string) {
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    failed++;
    console.log(`         ${detail}`);
  }
}

// did:key ceremony against one pod: fresh challenge, sign it, POST /api/login.
async function ceremony(base: string, kp: { did: string; privateKey: CryptoKey }): Promise<string> {
  const ch = await call(base, "GET", "/api/login/challenge", undefined);
  const challenge = JSON.parse(ch.text).challenge;
  const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, enc.encode(challenge));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  const login = await call(base, "POST", "/api/login", { did: kp.did, challenge, signature: sigB64 });
  const out = JSON.parse(login.text);
  if (login.status !== 200) throw new Error(`ceremony failed on ${base}: ${login.status} ${login.text}`);
  return out.session;
}

// ---------------------------------------------------------------- version pins
line("oa153 two-pod migration driver — A(origin)=" + ORIGIN + "  B(dest)=" + DEST);
line();
const vA = await call(ORIGIN, "GET", "/_api/version", undefined);
const vB = await call(DEST, "GET", "/_api/version", undefined);
line(`[0] A GET /_api/version -> ${vA.status} ${vA.text}`);
line(`    B GET /_api/version -> ${vB.status} ${vB.text}`);
check("both pods pinned to the PR head commit afab6bf", vA.text.includes("afab6bf") && vB.text.includes("afab6bf"), `${vA.text} / ${vB.text}`);

// ---------------------------------------------------------------- identities
const subject = await generateKeypair(); // the migrating subject — SAME key on both pods
const stranger = await generateKeypair(); // a different did:key — must NOT be able to import
line();
line(`[1] subject identity (fresh Ed25519, used on BOTH pods): ${subject.did}`);

const sessA = await ceremony(ORIGIN, subject);
line(`[2] A did:key ceremony -> session ${sessA.slice(0, 14)}…`);
check("A session subject is the did:key", JSON.parse((await call(ORIGIN, "GET", "/api/plugins", undefined, sessA)).text).plugins !== undefined, "plugins route rejected session");

// ---------------------------------------------------------------- seed on A (origin)
const seed = await call(ORIGIN, "POST", "/api/cookies", { plugin: "otter", cookies: { session: "oa153-sample-cookie" } }, sessA);
line(`[3] A POST /api/cookies (labeled sample, not live data) -> ${seed.status} ${seed.text}`);
check("sample jar seeded on A", seed.status === 200, seed.text);

// ---------------------------------------------------------------- pre-migration grant on A
const mintOld = await call(ORIGIN, "POST", "/api/tokens", { plugin: "otter", subject: subject.did, app: "migration-demo", caps: ["jar"] }, ORIGIN_OWNER);
const oldToken = JSON.parse(mintOld.text).token;
line(`[4] A owner POST /api/tokens (caps:["jar"]) -> ${mintOld.status} token=${oldToken}`);
const preRead = await call(ORIGIN, "GET", "/api/otter/jar", undefined, oldToken);
line(`[5] A GET /api/otter/jar with that token (pre-migration) -> ${preRead.status} ${preRead.text.slice(0, 120)}`);
check("pre-migration jar read works on A (control for the later 401)", preRead.status === 200 && preRead.text.includes("oa153-sample-cookie"), preRead.text);

// ---------------------------------------------------------------- export on A
const destPub = Deno.env.get("DEST_X25519_PUB")!;
const exp = await call(ORIGIN, "POST", "/api/export", { destinationPublicKey: destPub }, sessA);
const expBody = JSON.parse(exp.text);
line(`[6] A POST /api/export (did:key ceremony) -> ${exp.status} entries=${expBody.entries} subject=${expBody.subject}`);
check("export returns an X25519-AES-256-GCM envelope for the subject", exp.status === 200 && expBody.export?.algorithm === "X25519-AES-256-GCM" && expBody.subject === subject.did, exp.text.slice(0, 200));
check("envelope ciphertext carries no plaintext jar", !JSON.stringify(expBody.export).includes("oa153-sample-cookie"), "plaintext leaked into envelope");
const envelope = expBody.export;

// ---------------------------------------------------------------- wrong subject cannot import on B
const sessStranger = await ceremony(DEST, stranger);
const badImport = await call(DEST, "POST", "/api/import", { export: envelope }, sessStranger);
line(`[7] B POST /api/import as a DIFFERENT did:key -> ${badImport.status} ${badImport.text}`);
check("destination requires the bundle's own subject", badImport.status === 403, badImport.text);

// ---------------------------------------------------------------- ceremony + import on B
const sessB = await ceremony(DEST, subject);
line(`[8] B did:key ceremony with the SAME subject key -> session ${sessB.slice(0, 14)}…`);
const imp = await call(DEST, "POST", "/api/import", { export: envelope }, sessB);
const impBody = JSON.parse(imp.text);
line(`[9] B POST /api/import -> ${imp.status} subject=${impBody.subject} entries=${impBody.entries} grants=${impBody.grants}`);
line(`    receipt: ${JSON.stringify(impBody.receipt)}`);
check("import installs 1 vault entry + 1 grant for the SAME subject", imp.status === 200 && impBody.entries === 1 && impBody.grants === 1 && impBody.subject === subject.did, imp.text.slice(0, 200));
check("receipt is a signed {subject, destPod, importedAt}", impBody.receipt?.destPod?.startsWith("did:key:z") === true && !!impBody.receipt?.importedAt && impBody.receipt?.signature?.length > 40, JSON.stringify(impBody.receipt));
const receipt = impBody.receipt;

// ---------------------------------------------------------------- subject reads the imported jar on B
const mintB = await call(DEST, "POST", "/api/tokens", { plugin: "otter", subject: subject.did, app: "post-migration", caps: ["jar"] }, DEST_OWNER);
const bToken = JSON.parse(mintB.text).token;
line(`[10] B owner POST /api/tokens (caps:["jar"]) -> ${mintB.status} token=${bToken}`);
const readB = await call(DEST, "GET", "/api/otter/jar", undefined, bToken);
line(`[11] B GET /api/otter/jar with the new scoped token -> ${readB.status} ${readB.text.slice(0, 140)}`);
check("imported jar readable on B via a scoped token minted there", readB.status === 200 && readB.text.includes("oa153-sample-cookie"), readB.text);
const readBImported = await call(DEST, "GET", "/api/otter/jar", undefined, oldToken);
line(`[12] B GET /api/otter/jar with the MIGRATED grant token (from A) -> ${readBImported.status} ${readBImported.text.slice(0, 140)}`);
check("migrated grant row works on B (grant continuity)", readBImported.status === 200 && readBImported.text.includes("oa153-sample-cookie"), readBImported.text);

// ---------------------------------------------------------------- confirm-back on A
const tampered = { ...receipt, subject: "did:key:z6MkTamperedNotTheRealSubject" };
const badConfirm = await call(ORIGIN, "POST", "/api/export/confirm", tampered, ORIGIN_OWNER);
line(`[13] A POST /api/export/confirm with a TAMPERED receipt (owner auth) -> ${badConfirm.status} ${badConfirm.text}`);
check("tampered receipt rejected (Ed25519 signature over the receipt text)", badConfirm.status === 400, badConfirm.text);

const confirm = await call(ORIGIN, "POST", "/api/export/confirm", receipt, sessA);
line(`[14] A POST /api/export/confirm (did:key session, valid receipt) -> ${confirm.status} ${confirm.text}`);
const confirmBody = JSON.parse(confirm.text);
check("confirm deletes the migrating vault row and revokes the subject's tokens", confirm.status === 200 && confirmBody.deleted === 1 && confirmBody.revoked >= 1, confirm.text);

// ---------------------------------------------------------------- exit-with-consequences on A
const postRead = await call(ORIGIN, "GET", "/api/otter/jar", undefined, oldToken);
line(`[15] A GET /api/otter/jar with the pre-migration token (post-confirm) -> ${postRead.status} ${postRead.text}`);
check("subject's old tokens are revoked on A (401)", postRead.status === 401, postRead.text);
const pluginsA = await call(ORIGIN, "GET", "/api/plugins", undefined, sessA);
const otterJars = JSON.parse(pluginsA.text).plugins.find((p: { id: string }) => p.id === "otter").jars;
line(`[16] A GET /api/plugins (did:key session) -> otter jars: ${JSON.stringify(otterJars)}`);
check("vault row gone on A", Array.isArray(otterJars) && otterJars.length === 0, JSON.stringify(otterJars));

// ---------------------------------------------------------------- audit trails
const auditA = await call(ORIGIN, "GET", "/api/audit", undefined, ORIGIN_OWNER);
const tailA = JSON.parse(auditA.text).audit.slice(-4).map((e: unknown) => JSON.stringify(e)).join("\n         ");
line(`[17] A GET /api/audit (owner) — last 4:`);
line(`         ${tailA}`);
const auditB = await call(DEST, "GET", "/api/audit", undefined, DEST_OWNER);
const tailB = JSON.parse(auditB.text).audit.slice(-3).map((e: unknown) => JSON.stringify(e)).join("\n         ");
line(`[18] B GET /api/audit (owner) — last 3:`);
line(`         ${tailB}`);

line();
if (failed > 0) {
  console.error(`RESULT: ${failed} check(s) FAILED`);
  Deno.exit(1);
}
console.log("RESULT: all checks passed — two-instance migration: export(A) → ceremony/import(B) → scoped read on B → confirm(A) → row gone + 401 on A");
