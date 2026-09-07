import { x25519 } from "npm:@noble/curves@1.8.1/ed25519";
import { didKeyToEd25519 } from "./identity.ts";

export interface ExportedVaultEntry {
  plugin: string;
  account: string;
  jar: Record<string, string>;
  updatedAt: number;
  status?: "migrating";
}
export interface MigrationBundle {
  version: 0;
  subject: string;
  exportedAt: string;
  vault: ExportedVaultEntry[];
  grants: Record<string, unknown>[];
  delegationJwts: string[];
  provenance: Record<string, { capturedVia: string }>;
}
export interface EncryptedExport {
  version: 0;
  algorithm: "X25519-AES-256-GCM";
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}
export interface ConfirmReceipt {
  subject: string;
  destPod: string;
  importedAt: string;
  signature: string;
}

const encoder = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function decode(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" || !value) throw new Error(name + " is required");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  try { return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)); }
  catch { throw new Error("malformed " + name); }
}
function keyBytes(value: unknown, name: string): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) throw new Error(name + " must be 32 bytes");
    return value;
  }
  if (typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value)) {
    return Uint8Array.from(value.match(/../g)!.map((b) => parseInt(b, 16)));
  }
  const raw = decode(value, name);
  if (raw.length !== 32) throw new Error(name + " must be 32 bytes");
  return raw;
}
async function derive(shared: Uint8Array, salt: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: encoder.encode("oauth3-export-v0") },
    base, { name: "AES-GCM", length: 256 }, false, [usage],
  );
}

export async function encryptMigration(bundle: MigrationBundle, destinationPublicKey: Uint8Array): Promise<EncryptedExport> {
  if (destinationPublicKey.length !== 32) throw new Error("destination X25519 public key must be 32 bytes");
  const secret = x25519.utils.randomPrivateKey();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(x25519.getSharedSecret(secret, destinationPublicKey), salt, "encrypt");
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource }, key, encoder.encode(JSON.stringify(bundle)) as BufferSource,
  ));
  return { version: 0, algorithm: "X25519-AES-256-GCM", ephemeralPublicKey: b64url(x25519.getPublicKey(secret)),
    salt: b64url(salt), iv: b64url(iv), ciphertext: b64url(ciphertext) };
}

export async function decryptMigration(envelope: EncryptedExport, privateKey: unknown): Promise<MigrationBundle> {
  if (envelope?.version !== 0 || envelope.algorithm !== "X25519-AES-256-GCM") throw new Error("unsupported migration envelope");
  const secret = keyBytes(privateKey, "destination X25519 private key");
  const ephemeral = decode(envelope.ephemeralPublicKey, "ephemeral public key");
  if (ephemeral.length !== 32) throw new Error("ephemeral public key must be 32 bytes");
  const key = await derive(x25519.getSharedSecret(secret, ephemeral), decode(envelope.salt, "salt"), "decrypt");
  let plaintext: ArrayBuffer;
  try { plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(envelope.iv, "iv") as BufferSource }, key, decode(envelope.ciphertext, "ciphertext") as BufferSource); }
  catch { throw new Error("cannot decrypt migration bundle"); }
  let bundle: MigrationBundle;
  try { bundle = JSON.parse(new TextDecoder().decode(plaintext)); }
  catch { throw new Error("malformed migration bundle"); }
  if (bundle?.version !== 0 || typeof bundle.subject !== "string" || !Array.isArray(bundle.vault) ||
    !Array.isArray(bundle.grants) || !Array.isArray(bundle.delegationJwts)) throw new Error("malformed migration bundle");
  return bundle;
}

const receiptText = (r: Pick<ConfirmReceipt, "subject" | "destPod" | "importedAt">) =>
  JSON.stringify({ subject: r.subject, destPod: r.destPod, importedAt: r.importedAt });
export async function signReceipt(
  payload: Pick<ConfirmReceipt, "subject" | "destPod" | "importedAt">, privateJwk: JsonWebKey,
): Promise<ConfirmReceipt> {
  const key = await crypto.subtle.importKey("jwk", privateJwk, "Ed25519", false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, encoder.encode(receiptText(payload))));
  return { ...payload, signature: btoa(String.fromCharCode(...signature)) };
}
export async function verifyReceipt(receipt: ConfirmReceipt): Promise<boolean> {
  if (!receipt?.subject || !receipt.destPod?.startsWith("did:key:z") || !receipt.signature) return false;
  const publicKey = await crypto.subtle.importKey("raw", didKeyToEd25519(receipt.destPod) as BufferSource, "Ed25519", false, ["verify"]);
  return await crypto.subtle.verify("Ed25519", publicKey, Uint8Array.from(atob(receipt.signature), (c) => c.charCodeAt(0)),
    encoder.encode(receiptText(receipt)));
}
