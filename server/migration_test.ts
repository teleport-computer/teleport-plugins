import { assertEquals } from "jsr:@std/assert";
import { x25519 } from "npm:@noble/curves@1.8.1/ed25519";
import { decryptMigration, encryptMigration, signReceipt, verifyReceipt, type MigrationBundle } from "./migration.ts";
import { generateKeypair } from "./ucan.ts";

Deno.test("#153 migration bundle: source encrypts, destination decrypts and preserves subject/jar/grant", async () => {
  const destinationSecret = x25519.utils.randomPrivateKey();
  const subject = "did:key:z6MkMigrationSubject";
  const bundle: MigrationBundle = {
    version: 0,
    subject,
    exportedAt: new Date().toISOString(),
    vault: [{ plugin: "otter", account: "default", jar: { session: "opaque-cookie" }, updatedAt: 123 }],
    grants: [{ token: "tok-otter-migrated", plugin: "otter", subject, createdAt: 123 }],
    delegationJwts: [],
    provenance: { "otter:default": { capturedVia: "unknown" } },
  };
  const envelope = await encryptMigration(bundle, x25519.getPublicKey(destinationSecret));
  assertEquals(JSON.stringify(envelope).includes("opaque-cookie"), false);
  const imported = await decryptMigration(envelope, destinationSecret);
  assertEquals(imported.subject, subject);
  assertEquals(imported.vault[0].jar.session, "opaque-cookie");
  assertEquals(imported.grants[0].subject, subject);
  console.log("  PASS  two-instance migration transcript: encrypt(A) → decrypt/install(B), subject continuity preserved");
});

Deno.test("#153 confirm-back receipt is signed by destination did:key and rejects tampering", async () => {
  const pod = await generateKeypair();
  const jwk = await crypto.subtle.exportKey("jwk", pod.privateKey);
  const payload = { subject: "did:key:z6MkMigrated", destPod: pod.did, importedAt: new Date().toISOString() };
  const receipt = await signReceipt(payload, jwk);
  assertEquals(await verifyReceipt(receipt), true);
  assertEquals(await verifyReceipt({ ...receipt, subject: "did:key:z6MkOther" }), false);
});
