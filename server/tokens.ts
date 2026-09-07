// Scoped read tokens — the oauth3-twitter-cookie "post key" model, read-only.
// The owner (holding OWNER_SECRET) mints a token bound to one plugin and an
// optional subject/app (attribution). An app presents the token to read that
// plugin's items; it never sees the raw cookie jar. Tokens are revocable.

import { cidForToken, generateKeypair, mint as mintDelegation, verify as verifyDelegation, type Keypair } from "./ucan.ts";

export interface Token {
  token: string;
  plugin: string;
  subject?: string;
  app?: string;
  caps?: string[]; // extra capabilities beyond read (e.g. "jar" = raw-jar release, "write:event:<id>" = one-event edit)
  account?: string; // #111: bind the token to ONE account's jar when a subject holds several for this plugin
  delegation?: string;
  delegationCid?: string;
  delegationAudience?: string;
  createdAt: number;
  revokedAt?: number;
}

let file = "";
let tokens: Record<string, Token> = {};
let revokedCids: Record<string, true> = {};
let pod: Keypair | null = null;

const enc = new TextEncoder();
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] * 256; digits[i] = carry % 58; carry = Math.floor(carry / 58); }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let out = "1".repeat(bytes.findIndex((x) => x !== 0) < 0 ? bytes.length : bytes.findIndex((x) => x !== 0));
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
async function derivePod(sealKey: string): Promise<Keypair> {
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`oauth3/pod-did/v1:${sealKey}`)));
  const prefix = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0, 0x30, 5, 6, 3, 0x2b, 0x65, 0x70, 4, 0x22, 4, 0x20]);
  const pkcs8 = new Uint8Array(prefix.length + seed.length); pkcs8.set(prefix); pkcs8.set(seed, prefix.length);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey) as JsonWebKey;
  const x = jwk.x!.replace(/-/g, "+").replace(/_/g, "/");
  const raw = Uint8Array.from(atob(x + "=".repeat((4 - x.length % 4) % 4)), (c) => c.charCodeAt(0));
  const publicKey = await crypto.subtle.importKey("raw", raw, "Ed25519", true, ["verify"]);
  return { did: `did:key:z${b58(new Uint8Array([0xed, 0x01, ...raw]))}`, privateKey, publicKey };
}

async function persist(): Promise<void> {
  if (file) await Deno.writeTextFile(file, JSON.stringify({ tokens, revokedCids }));
}

export async function initTokens(dir: string, sealKey?: string): Promise<void> {
  if (dir) {
    if (!sealKey) throw new Error("SEAL_KEY required for token delegations");
    pod = await derivePod(sealKey);
  } else if (!pod) {
    pod = await generateKeypair();
  }
  if (!dir) return;
  file = `${dir}/tokens.json`;
  try {
    const parsed = JSON.parse(await Deno.readTextFile(file));
    if (parsed.tokens) { tokens = parsed.tokens; revokedCids = parsed.revokedCids ?? {}; }
    else tokens = parsed;
  }
  catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
}

// #131: a token MUST carry a subject. `subject` is REQUIRED (compile-time guard for every caller)
// and empty strings are rejected at runtime — no subjectless token can be created here. The read
// side (handler `jarSubject`) still defends against any subjectless token persisted from before.
export async function mint(plugin: string, subject: string, app?: string, caps?: string[], account?: string): Promise<Token> {
  if (!subject) throw new Error("mint: subject is required (a token must be bound to a subject)")
  const token = `tok-${plugin}-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  if (!pod) pod = await generateKeypair();
  const issuer = pod;
  const audience = app?.startsWith("did:key:") ? app : (await generateKeypair()).did;
  const resource = `tinycloud:key:${issuer.did.slice("did:key:".length)}:oauth3/${encodeURIComponent(subject)}/${plugin}`;
  const capabilities = (caps ?? []).map((cap) => ({ with: resource, can: `${plugin}/${cap}` }));
  const delegation = await mintDelegation({ issuer, audience, capabilities, expiresInSec: 365 * 24 * 60 * 60 });
  const t: Token = {
    token,
    plugin,
    subject,
    app,
    ...(caps?.length ? { caps } : {}),
    ...(account ? { account } : {}),
    delegation,
    delegationCid: cidForToken(delegation),
    delegationAudience: audience,
    createdAt: Date.now(),
  };
  tokens[token] = t;
  await persist();
  return t;
}

// Rejects unknown, wrong-plugin, AND revoked tokens.
export function verify(token: string, plugin: string): Token | null {
  const t = tokens[token];
  return t && t.plugin === plugin && !t.revokedAt && (!t.delegationCid || !revokedCids[t.delegationCid]) ? t : null;
}

export async function verifiedCaps(t: Token): Promise<string[] | undefined> {
  if (!t.delegation || !t.delegationCid || revokedCids[t.delegationCid] || !pod) throw new Error("token delegation is missing or revoked");
  const payload = await verifyDelegation(t.delegation, { root: pod.did });
  if (payload.iss !== pod.did) throw new Error("token delegation issuer is not this pod");
  const resource = `tinycloud:key:${pod.did.slice("did:key:".length)}:oauth3/${encodeURIComponent(t.subject ?? "")}/${t.plugin}`;
  const caps: string[] = [];
  for (const [with_, abilities] of Object.entries(payload.att)) {
    if (with_ !== resource) throw new Error("token delegation resource mismatch");
    for (const ability of Object.keys(abilities)) {
      if (!ability.startsWith(`${t.plugin}/`)) throw new Error("token delegation ability mismatch");
      caps.push(ability.slice(t.plugin.length + 1));
    }
  }
  return caps.length ? caps : undefined;
}

// Like verify, but also requires the token to carry a specific capability string.
// Cap strings are exact (no globbing): "write:event:A" does NOT satisfy "write:event:B",
// so an event-scoped write cap attenuates to exactly one event id. A read-only token
// (no caps) is rejected for any capability. Used by the google-calendar write endpoint.
// Returns the token when satisfied, else null.
export function verifyCap(token: string, plugin: string, cap: string): Token | null {
  const t = verify(token, plugin);
  return t && t.caps?.includes(cap) ? t : null;
}

export async function revoke(token: string): Promise<boolean> {
  const t = tokens[token];
  if (!t) return false;
  if (!t.revokedAt) { t.revokedAt = Date.now(); if (t.delegationCid) revokedCids[t.delegationCid] = true; await persist(); }
  return true;
}

export async function importTokens(grants: Token[]): Promise<number> {
  for (const grant of grants) {
    if (!grant || typeof grant.token !== "string" || typeof grant.plugin !== "string" ||
      typeof grant.subject !== "string") throw new Error("malformed grant row");
    tokens[grant.token] = { ...grant };
  }
  if (grants.length) await persist();
  return grants.length;
}

export async function revokeSubject(subject: string): Promise<number> {
  let count = 0;
  for (const token of Object.values(tokens)) {
    if (token.subject === subject && !token.revokedAt) {
      token.revokedAt = Date.now();
      if (token.delegationCid) revokedCids[token.delegationCid] = true;
      count++;
    }
  }
  if (count) await persist();
  return count;
}

export function listTokens(): Token[] {
  return Object.values(tokens).sort((a, b) => b.createdAt - a.createdAt);
}

export function tokensForSubject(subject: string): Token[] {
  return listTokens().filter((token) => token.subject === subject);
}
