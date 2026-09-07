import { x25519 } from "npm:@noble/curves@1.8.1/ed25519";

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function decodeKey(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value) {
    throw new Error("destination X25519 public key is required");
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Uint8Array.from(value.match(/../g)!.map((b) => parseInt(b, 16)));
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  } catch {
    throw new Error("malformed destination X25519 public key");
  }
  if (raw.length !== 32) throw new Error("destination X25519 public key must be 32 bytes");
  return raw;
}

export interface ExportBundle {
  version: 0;
  subject: string;
  exportedAt: string;
  vault: unknown[];
  grants: unknown[];
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

export async function encryptExport(
  bundle: ExportBundle,
  destinationPublicKey: unknown,
): Promise<EncryptedExport> {
  const destination = decodeKey(destinationPublicKey);
  const ephemeralSecret = x25519.utils.randomPrivateKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralSecret);
  const shared = x25519.getSharedSecret(ephemeralSecret, destination);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: encoder.encode("oauth3-export-v0"),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      aesKey,
      encoder.encode(JSON.stringify(bundle)) as BufferSource,
    ),
  );
  return {
    version: 0,
    algorithm: "X25519-AES-256-GCM",
    ephemeralPublicKey: b64url(ephemeralPublicKey),
    salt: b64url(salt),
    iv: b64url(iv),
    ciphertext: b64url(ciphertext),
  };
}
