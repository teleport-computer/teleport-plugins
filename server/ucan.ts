// TinyCloud-dialect did:key UCANs. The wire format is deliberately small and strict:
// an EdDSA JWT whose attestations are an ERC-5573 resource -> ability -> caveats map.
import { didKeyToEd25519 } from "./identity.ts";
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3";

export type Caveat = Record<string, unknown>;
export type Att = Record<string, Record<string, Caveat[]>>;
export interface Capability {
  with: string;
  can: string;
  caveats?: Caveat[];
}
export interface Keypair {
  did: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}
export interface Payload {
  iss: string;
  aud: string;
  exp: number;
  nbf?: number;
  nnc: string;
  prf: string[];
  att: Att;
  binding?: string;
}
export interface MintOpts {
  issuer: Keypair;
  audience: string;
  capabilities: Capability[];
  expiresInSec: number;
  notBefore?: number;
  proofs?: string[];
  now?: number;
  binding?: string;
}
export interface BindingQuoteOpts {
  instance: Keypair;
  app: string;
  measurement: string;
  nonce: string;
  expiresInSec: number;
  now?: number;
}
export interface BindingQuotePayload {
  iss: string;
  app: string;
  measurement: string;
  nonce: string;
  exp: number;
}
export interface VerifyOpts {
  root: string;
  now?: number;
  proofs?: ProofStore;
  admitApp?: (app: string, measurement: string) => boolean | Promise<boolean>;
  usedBindingNonces?: Set<string>;
}
export type ProofStore = Map<string, string> | Record<string, string>;

const enc = new TextEncoder();
const dec = new TextDecoder();
const source = (b: Uint8Array) => b as unknown as BufferSource;
const b64 = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
const jsonPart = (v: unknown) => b64(enc.encode(JSON.stringify(v)));
const APP_ID = /^appauth:[a-z0-9-]+:0x[0-9a-f]{40}$/;

function assertAudience(audience: string): void {
  if (!/^did:key:z[^#]+$/.test(audience) && !APP_ID.test(audience)) {
    throw new Error(`invalid audience: ${audience}`);
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(
    bytes.findIndex((b) => b !== 0) < 0 ? bytes.length : bytes.findIndex((b) => b !== 0),
  );
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
function didFromRaw(raw: Uint8Array): string {
  const multicodec = new Uint8Array([0xed, 0x01, ...raw]);
  return `did:key:z${b58(multicodec)}`;
}

export async function generateKeypair(): Promise<Keypair> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  return {
    did: didFromRaw(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
}

// Raw Ed25519 sign/verify over arbitrary bytes — for self-signed records whose payload is
// not a UCAN (e.g. RFC 0013 locator records). did:key identifies the signer. Reuses the
// did:key codec above so all Ed25519/did:key math lives in one place. Adapted to #155's
// ucan.ts rewrite: bs() -> source() (line ~45), and a private pubKeyFromDid mirroring the
// importKey pattern verifyAt uses, so #154 locator records and #155's verifier coexist with
// no duplicate sign().
export async function signBytes(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, source(data)));
}
async function pubKeyFromDid(did: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    source(didKeyToEd25519(did.split("#")[0])),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}
export async function verifySig(pubDid: string, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try {
    return await crypto.subtle.verify("Ed25519", await pubKeyFromDid(pubDid), source(sig), source(data));
  } catch {
    return false;
  }
}

function resourceParts(resource: string) {
  const m = /^(tinycloud:key:[^/]+):([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?(?:#(.*))?$/.exec(
    resource,
  );
  if (!m || !m[1].startsWith("tinycloud:key:z")) {
    throw new Error(`invalid TinyCloud resource: ${resource}`);
  }
  didKeyToEd25519(spaceDid(m[1]));
  return { space: m[1], service: m[2], path: m[3] ?? "", query: m[4] ?? "", fragment: m[5] ?? "" };
}
function spaceDid(space: string): string {
  const value = space.slice("tinycloud:key:".length);
  return `did:key:${value}`;
}
function extendsResource(parent: string, child: string): boolean {
  const p = resourceParts(parent), c = resourceParts(child);
  if (
    p.space !== c.space || p.service !== c.service || p.query !== c.query ||
    p.fragment !== c.fragment
  ) return false;
  return c.path === p.path || (p.path === "" ? true : c.path.startsWith(`${p.path}/`));
}
function caveatsNarrower(parent: Caveat, child: Caveat): boolean {
  for (const [key, value] of Object.entries(parent)) {
    const next = child[key];
    if (next === undefined) return false;
    if (key === "maxRate" || key === "until") {
      if (typeof value !== "number" || typeof next !== "number" || next > value) return false;
    } else if (next !== value) return false;
  }
  return true;
}
function capabilityMap(capabilities: Capability[]): Att {
  const att: Att = {};
  for (const cap of capabilities) {
    resourceParts(cap.with);
    if (!cap.can || cap.can.includes(" ")) throw new Error("invalid ability");
    const caveats = cap.caveats === undefined || cap.caveats.length === 0 ? [{}] : cap.caveats;
    for (const caveat of caveats) {
      if (!caveat || Array.isArray(caveat) || typeof caveat !== "object") {
        throw new Error("invalid caveat");
      }
    }
    (att[cap.with] ??= {})[cap.can] = caveats;
  }
  return att;
}
function capabilities(att: Att): Capability[] {
  if (!att || Array.isArray(att) || typeof att !== "object") throw new Error("att must be a map");
  const out: Capability[] = [];
  for (const [with_, abilities] of Object.entries(att)) {
    resourceParts(with_);
    if (!abilities || Array.isArray(abilities) || typeof abilities !== "object") {
      throw new Error("invalid att ability map");
    }
    for (const [can, caveats] of Object.entries(abilities)) {
      if (!Array.isArray(caveats) || caveats.length === 0) {
        throw new Error("bare [] caveats are invalid");
      }
      for (const caveat of caveats) {
        if (!caveat || Array.isArray(caveat) || typeof caveat !== "object") {
          throw new Error("invalid caveat");
        }
      }
      out.push({ with: with_, can, caveats });
    }
  }
  return out;
}
function covered(parent: Capability, child: Capability): boolean {
  return parent.can === child.can && extendsResource(parent.with, child.with) &&
    (parent.caveats ?? [{}]).some((p) =>
      (child.caveats ?? [{}]).some((c) => caveatsNarrower(p, c))
    );
}

function header(): string {
  return jsonPart({ alg: "EdDSA", typ: "JWT", ucv: "0.1-oauth3" });
}
async function sign(payload: Payload, key: CryptoKey): Promise<string> {
  const h = header(), body = jsonPart(payload), input = `${h}.${body}`;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, source(enc.encode(input))));
  return `${input}.${b64(sig)}`;
}
async function signBinding(payload: BindingQuotePayload, key: CryptoKey): Promise<string> {
  const h = jsonPart({ alg: "EdDSA", typ: "oauth3-app-binding", ucv: "0.1-oauth3" });
  const body = jsonPart(payload), input = `${h}.${body}`;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, source(enc.encode(input))));
  return `${input}.${b64(sig)}`;
}
export async function createBindingQuote(o: BindingQuoteOpts): Promise<string> {
  if (!APP_ID.test(o.app)) throw new Error(`invalid app identity: ${o.app}`);
  if (!o.measurement || !o.nonce) throw new Error("binding quote requires measurement and nonce");
  const now = o.now ?? Math.floor(Date.now() / 1000);
  return await signBinding({
    iss: o.instance.did,
    app: o.app,
    measurement: o.measurement,
    nonce: o.nonce,
    exp: now + o.expiresInSec,
  }, o.instance.privateKey);
}
export async function mint(o: MintOpts): Promise<string> {
  if (!Number.isInteger(o.expiresInSec) || o.expiresInSec <= 0) {
    throw new Error("expiresInSec must be positive");
  }
  assertAudience(o.audience);
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const payload: Payload = {
    iss: o.issuer.did,
    aud: o.audience,
    exp: now + o.expiresInSec,
    nnc: crypto.randomUUID(),
    prf: o.proofs ?? [],
    att: capabilityMap(o.capabilities),
  };
  if (o.notBefore !== undefined) payload.nbf = o.notBefore;
  if (o.binding !== undefined) payload.binding = o.binding;
  return await sign(payload, o.issuer.privateKey);
}
export async function delegate(o: MintOpts): Promise<string> {
  const proofs = (o.proofs ?? []).map((parent) => cidForToken(parent));
  return await mint({ ...o, proofs });
}

function parse(token: string): { payload: Payload; signingInput: string; signature: Uint8Array } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new Error("malformed JWT");
  let h: unknown, p: unknown;
  try {
    h = JSON.parse(dec.decode(unb64(parts[0])));
    p = JSON.parse(dec.decode(unb64(parts[1])));
  } catch {
    throw new Error("malformed JWT JSON");
  }
  if (JSON.stringify(h) !== JSON.stringify({ alg: "EdDSA", typ: "JWT", ucv: "0.1-oauth3" })) {
    throw new Error("unsupported JWT header");
  }
  const payload = p as Payload;
  if (typeof payload.iss !== "string" || !payload.iss.startsWith("did:key:z")) {
    throw new Error("missing or invalid iss");
  }
  if (typeof payload.aud !== "string") throw new Error("missing or invalid aud");
  assertAudience(payload.aud);
  if (
    !Number.isFinite(payload.exp) || typeof payload.nnc !== "string" || !Array.isArray(payload.prf)
  ) throw new Error("missing required claim");
  capabilities(payload.att);
  if (payload.nbf !== undefined && !Number.isFinite(payload.nbf)) throw new Error("invalid nbf");
  return { payload, signingInput: `${parts[0]}.${parts[1]}`, signature: unb64(parts[2]) };
}
export function decode(token: string): Payload {
  return parse(token).payload;
}

function varint(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) out += alphabet[(value >>> (bits -= 5)) & 31];
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
export function cidForToken(token: string): string {
  const digest = blake3(enc.encode(token), { dkLen: 32 });
  return `b${
    base32(
      Uint8Array.from([...varint(1), ...varint(0x55), ...varint(0x1e), ...varint(32), ...digest]),
    )
  }`;
}
function proof(store: ProofStore | undefined, cid: string): string {
  const token = store instanceof Map ? store.get(cid) : store?.[cid];
  if (!token) throw new Error(`missing proof ${cid}`);
  if (cidForToken(token) !== cid) throw new Error(`wrong CID for proof ${cid}`);
  return token;
}
async function verifyBindingQuote(
  quote: string,
  instance: string,
  app: string,
  opts: VerifyOpts,
): Promise<void> {
  const parts = quote.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("malformed binding quote");
  }
  let header: unknown, payload: BindingQuotePayload;
  try {
    header = JSON.parse(dec.decode(unb64(parts[0])));
    payload = JSON.parse(dec.decode(unb64(parts[1]))) as BindingQuotePayload;
  } catch {
    throw new Error("malformed binding quote JSON");
  }
  if (
    JSON.stringify(header) !==
      JSON.stringify({ alg: "EdDSA", typ: "oauth3-app-binding", ucv: "0.1-oauth3" })
  ) {
    throw new Error("unsupported binding quote header");
  }
  if (
    payload.iss !== instance || payload.app !== app || !APP_ID.test(payload.app) ||
    !payload.measurement || !payload.nonce || !Number.isFinite(payload.exp)
  ) throw new Error("invalid binding quote claims");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (now >= payload.exp) throw new Error("binding quote expired");
  const valid = await crypto.subtle.verify(
    "Ed25519",
    await pubKeyFromDid(payload.iss),
    source(unb64(parts[2])),
    source(enc.encode(`${parts[0]}.${parts[1]}`)),
  );
  if (!valid) throw new Error("bad binding quote signature");
  if (!opts.admitApp) throw new Error("app admission verifier is required");
  if (!await opts.admitApp(payload.app, payload.measurement)) {
    throw new Error("app measurement is not admitted");
  }
  if (!opts.usedBindingNonces) throw new Error("binding nonce store is required");
  if (opts.usedBindingNonces.has(payload.nonce)) throw new Error("binding quote replayed");
  opts.usedBindingNonces.add(payload.nonce);
}
async function verifyAt(token: string, opts: VerifyOpts, seen: Set<string>): Promise<Payload> {
  if (seen.has(token)) throw new Error("cyclic proof chain");
  seen.add(token);
  const { payload, signingInput, signature } = parse(token);
  const issuer = payload.iss.split("#")[0];
  const key = await crypto.subtle.importKey(
    "raw",
    source(didKeyToEd25519(issuer)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (
    !await crypto.subtle.verify("Ed25519", key, source(signature), source(enc.encode(signingInput)))
  ) throw new Error("bad signature");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (payload.nbf !== undefined && now < payload.nbf) throw new Error("token not yet valid");
  if (now >= payload.exp) throw new Error("token expired");
  const children = capabilities(payload.att);
  if (payload.prf.length === 0) {
    if (issuer !== opts.root) throw new Error("root issuer is not trusted");
    return payload;
  }
  for (const cid of payload.prf) {
    if (typeof cid !== "string") throw new Error("invalid proof CID");
    const parentToken = proof(opts.proofs, cid);
    const parent = await verifyAt(parentToken, opts, new Set(seen));
    if (issuer !== parent.aud) {
      if (!APP_ID.test(parent.aud) || !payload.binding) {
        throw new Error("delegation issuer does not equal parent audience");
      }
      await verifyBindingQuote(payload.binding, issuer, parent.aud, opts);
    }
    if (payload.exp > parent.exp) throw new Error("delegation expiry widens parent");
    if ((payload.nbf ?? 0) < (parent.nbf ?? 0)) throw new Error("delegation nbf widens parent");
    const parents = capabilities(parent.att);
    for (const child of children) {
      if (!parents.some((p) => covered(p, child))) {
        throw new Error("capability is not attenuated from parent");
      }
    }
  }
  return payload;
}
export async function verify(token: string, opts: VerifyOpts): Promise<Payload> {
  return await verifyAt(token, opts, new Set());
}

export interface Invocation {
  with: string;
  can: string;
  caveats?: Caveat;
}
export async function canInvoke(
  token: string,
  req: Invocation,
  opts: VerifyOpts,
): Promise<Capability> {
  const payload = await verify(token, opts);
  for (const cap of capabilities(payload.att)) {
    if (
      extendsResource(cap.with, req.with) && cap.can === req.can &&
      (cap.caveats ?? [{}]).some((c) => caveatsNarrower(c, req.caveats ?? {}))
    ) return cap;
  }
  throw new Error(`no capability authorizes ${req.can} on ${req.with}`);
}
