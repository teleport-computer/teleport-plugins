// Cap machinery for #69 — the event-scoped write capability. These tests pin the
// security property the issue is about: a "write:event:<id>" token attenuates a
// delegated write to EXACTLY one event. A token for event A must not satisfy a write
// to event B, a read-only token must not satisfy any write, and the cap strings must
// not prefix-bleed ("write:event:AB" ≠ "write:event:A"). Plus an in-process check that
// the POST /api/google-calendar/event/:id endpoint enforces the same at the handler.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { importTokens, mint, revoke, verifiedCaps, verify, verifyCap } from "./tokens.ts";
import { decode } from "./ucan.ts";
import { scopeReads } from "./scopes.ts";
import handler from "./handler.ts";

const PLUGIN = "google-calendar";

Deno.test("verifyCap: write:event:A accepted for A, rejected for B", async () => {
  const t = await mint(PLUGIN, "owner", "share-app", ["write:event:A"]);
  assertEquals(verifyCap(t.token, PLUGIN, "write:event:A") !== null, true);
  assertEquals(verifyCap(t.token, PLUGIN, "write:event:B"), null); // cross-event rejected
  assertEquals(verifyCap(t.token, PLUGIN, "jar"), null); // unrelated cap rejected
  assertEquals(verifyCap(t.token, "otter", "write:event:A"), null); // wrong plugin rejected
});

Deno.test("verifyCap: read-only token rejected for writes, still reads", async () => {
  const ro = await mint(PLUGIN, "owner", "reader-app"); // no caps
  assertEquals(verifyCap(ro.token, PLUGIN, "write:event:A"), null); // no write cap
  assertEquals(verifyCap(ro.token, PLUGIN, "jar"), null);
  assertEquals(verify(ro.token, PLUGIN) !== null, true); // plain read still works
});

Deno.test("verifyCap: exact string — no prefix bleed (AB ≠ A)", async () => {
  const t = await mint(PLUGIN, "owner", "app", ["write:event:AB"]);
  assertEquals(verifyCap(t.token, PLUGIN, "write:event:AB") !== null, true);
  assertEquals(verifyCap(t.token, PLUGIN, "write:event:A"), null); // would let AB edit A — must fail
});

Deno.test("verifyCap: revoked token rejected", async () => {
  const t = await mint(PLUGIN, "owner", "app", ["write:event:A"]);
  assertEquals(await revoke(t.token), true);
  assertEquals(verifyCap(t.token, PLUGIN, "write:event:A"), null);
});

// In-process handler gating: the endpoint must accept the right cap (and the owner),
// and reject everything else. No jar is synced, so an authorized request stops at 409
// "no jar" — which is exactly the signal that GATING passed. Unauthorized → 401.
Deno.test("handler POST /api/google-calendar/event/:id — cap gating", async () => {
  const OWNER = "test-owner-secret-69";
  const ctx = { env: { OWNER_SECRET: OWNER }, dataDir: "" }; // in-memory: no scheduler, no SEAL_KEY
  const evA = "evt-AAA";
  const capA = await mint(PLUGIN, "owner", "share-app", [`write:event:${evA}`]);
  const capB = await mint(PLUGIN, "owner", "share-app", ["write:event:evt-BBB"]);
  const readOnly = await mint(PLUGIN, "owner", "reader-app");

  const post = (bearer: string | null) =>
    handler(
      new Request(`http://localhost/api/${PLUGIN}/event/${evA}`, {
        method: "POST",
        headers: bearer
          ? { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }
          : { "Content-Type": "application/json" },
        body: "{}",
      }),
      ctx,
    );

  // Authorized paths stop at 409 (no jar synced) — gating passed.
  assertEquals((await post(capA.token)).status, 409);
  assertEquals((await post(OWNER)).status, 409);
  // Unauthorized paths → 401 (the whole point of the attenuation).
  assertEquals((await post(capB.token)).status, 401); // wrong event
  assertEquals((await post(readOnly.token)).status, 401); // read-only token
  assertEquals((await post(null)).status, 401); // no credentials
});

// #131: mint refuses to create a subjectless token (empty string rejected at runtime; the
// omitted-argument case is a compile error since `subject` is a required parameter).
Deno.test("mint: subjectless token is rejected at mint time", async () => {
  await assertRejects(() => mint(PLUGIN, "", "app"), Error, "subject is required");
  const ok = await mint(PLUGIN, "u-real", "app"); // a real subject still mints
  assertEquals(ok.subject, "u-real");
});

Deno.test("grant delegation: att derives the existing scope set and tampering fails closed", async () => {
  const t = await mint("reddit", "u-grant-test", "grant-app", ["reddit:karma"]);
  assert(t.delegation && t.delegationCid);
  const payload = decode(t.delegation);
  assertEquals(Object.values(payload.att).flatMap((abilities) => Object.keys(abilities)), ["reddit/reddit:karma"]);
  assertEquals(await verifiedCaps(t), ["reddit:karma"]);
  assertEquals(scopeReads(await verifiedCaps(t)), scopeReads(["reddit:karma"]));
  const parts = t.delegation.split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  const tampered = { ...t, delegation: parts.join(".") };
  await assertRejects(() => verifiedCaps(tampered), Error);
  await importTokens([{ ...tampered, token: `${t.token}-tampered` }]);
  const response = await handler(new Request("http://localhost/api/reddit/account", {
    headers: { Authorization: `Bearer ${t.token}-tampered` },
  }), { env: { OWNER_SECRET: "test-owner-secret" }, dataDir: "" });
  assertEquals(response.status, 403);
});

Deno.test("grant delegation: generated audience is persisted when app has no did:key", async () => {
  const t = await mint("reddit", "u-audience-test", "plain-app");
  assert(t.delegationAudience?.startsWith("did:key:z"));
  assertEquals(decode(t.delegation!).aud, t.delegationAudience);
});
