import { x25519 } from "npm:@noble/curves@1.8.1/ed25519";
import { assertEquals, assertExists } from "jsr:@std/assert";
import handler from "./handler.ts";
import { entriesForExport, setJar } from "./vault.ts";
import { mint } from "./tokens.ts";

const OWNER = "export-test-owner";
const CTX = { env: { OWNER_SECRET: OWNER, SEAL_KEY: "00".repeat(32) }, dataDir: "" };

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

async function decryptEnvelope(
  envelope: Record<string, string>,
  secret: Uint8Array,
): Promise<Record<string, any>> {
  const shared = x25519.getSharedSecret(secret, b64urlDecode(envelope.ephemeralPublicKey));
  const base = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: b64urlDecode(envelope.salt) as BufferSource,
      info: new TextEncoder().encode("oauth3-export-v0"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlDecode(envelope.iv) as BufferSource },
    key,
    b64urlDecode(envelope.ciphertext) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

Deno.test("export: encrypted bundle contains the subject vault and grant rows", async () => {
  const subject = `export-subject-${crypto.randomUUID()}`;
  await setJar(subject, "otter", "default", { session: "sample-cookie" });
  const grant = await mint("otter", subject, "migration-test");
  const destinationSecret = x25519.utils.randomPrivateKey();
  const destinationPublicKey = btoa(String.fromCharCode(...x25519.getPublicKey(destinationSecret)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const response = await handler(
    new Request("http://localhost/api/export", {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subject, destinationPublicKey }),
    }),
    CTX,
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertExists(body.export);
  const bundle = await decryptEnvelope(body.export, destinationSecret);
  assertEquals(bundle.subject, subject);
  assertEquals(bundle.vault[0].jar, { session: "sample-cookie" });
  assertEquals(bundle.grants[0].token, grant.token);
  assertEquals(bundle.delegationJwts, []);
  assertEquals(entriesForExport(subject)[0].status, "migrating");
});

Deno.test("export: unknown subject errors and does not create a bundle", async () => {
  const destinationSecret = x25519.utils.randomPrivateKey();
  const destinationPublicKey = btoa(String.fromCharCode(...x25519.getPublicKey(destinationSecret)));
  const response = await handler(
    new Request("http://localhost/api/export", {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subject: `missing-${crypto.randomUUID()}`, destinationPublicKey }),
    }),
    CTX,
  );
  assertEquals(response.status, 404);
  assertEquals((await response.json()).error, "unknown subject");
});

Deno.test("export: malformed destination key is rejected", async () => {
  const subject = `malformed-${crypto.randomUUID()}`;
  await setJar(subject, "otter", "default", { session: "sample-cookie" });
  const response = await handler(
    new Request("http://localhost/api/export", {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subject, destinationPublicKey: "bad-key" }),
    }),
    CTX,
  );
  assertEquals(response.status, 400);
  assertEquals(entriesForExport(subject)[0].status, undefined);
});
