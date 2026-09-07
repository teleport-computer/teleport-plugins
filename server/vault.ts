// Per-tenant, per-plugin, per-account cookie jars, sealed at rest with AES-GCM. The
// cookie jar is the raw credential, so it is never written in plaintext. SEAL_KEY
// (32-byte hex) is the per-app key the daemon derives from TEE material (dstack GetKey
// → HKDF) and injects via the isolated-container argv — never committed to source. Dev
// sets it in .env. Keyed by `${subject}:${plugin}:${account}` so one signed-in identity
// can hold MORE THAN ONE account per plugin (e.g. the owner's personal twitter account
// and a bot account coexist instead of clobbering). The account label is DERIVED from the
// jar itself (plugin.accountId) at sync time — no user-supplied naming, no second identity.

import { Jar } from "./plugins/types.ts";

interface Entry { jar: Jar; updatedAt: number; status?: "migrating"; }

// Thrown when a caller asks for a jar by (subject, plugin) alone but that identity holds
// more than one account for that plugin. Never silently pick one — surface it to the
// client as HTTP 409 carrying the available accounts so it can re-ask with `account` set.
export class AmbiguousAccountError extends Error {
  readonly accounts: string[];
  readonly subject: string;
  readonly plugin: string;
  constructor(subject: string, plugin: string, accounts: string[]) {
    super(`multiple accounts synced for ${subject}:${plugin}: ${accounts.join(", ")} — specify one`);
    this.name = "AmbiguousAccountError";
    this.subject = subject;
    this.plugin = plugin;
    this.accounts = accounts;
  }
}

// 3-part key. `plugin` and `account` are colon-free by construction (plugin ids are
// url-safe slugs; account is a derived id or the literal "default"), so a key is parsed
// from the RIGHT — the subject (which may itself contain colons: did:key:…, gh:…, …) is
// whatever remains. That keeps the build/parse inverse correct for every subject shape.
const keyOf = (subject: string, plugin: string, account: string) => `${subject}:${plugin}:${account}`;

function parseKey(k: string): { subject: string; plugin: string; account: string } {
  const accIdx = k.lastIndexOf(":");
  const account = k.slice(accIdx + 1);
  const rest = k.slice(0, accIdx);
  const plugIdx = rest.lastIndexOf(":");
  const plugin = rest.slice(plugIdx + 1);
  const subject = rest.slice(0, plugIdx);
  return { subject, plugin, account };
}

let file = "";
let key: CryptoKey | null = null;
let store: Record<string, Entry> = {};

function fromHex(h: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("SEAL_KEY must be 32 bytes (64 hex chars)");
  return Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
}

// deriveAccount, when provided, turns a legacy 2-part-key jar into its account label the
// SAME way sync does (plugin.accountId, or "default" for single-account plugins). It is
// injected (not imported) so vault.ts stays plugin-agnostic and unit-testable in isolation.
export async function initVault(
  dir: string,
  keyHex: string,
  deriveAccount?: (plugin: string, jar: Jar) => string,
): Promise<void> {
  if (!dir) return; // in-memory only (no DATA_DIR) — dev/test
  if (!keyHex) throw new Error("SEAL_KEY required to seal the cookie vault");
  key = await crypto.subtle.importKey("raw", fromHex(keyHex) as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  file = `${dir}/vault.sealed`;
  try {
    const raw = await Deno.readFile(file);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12) as BufferSource }, key, raw.subarray(12) as BufferSource);
    const parsed = JSON.parse(new TextDecoder().decode(pt));
    // New on-disk shape: { v: 3, store }. Legacy shape: a bare Record<string, Entry> with
    // 1-part ("<plugin>") or 2-part ("subject:plugin") keys.
    let migrated = 0;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.v === 3 && typeof parsed.store === "object") {
      store = parsed.store as Record<string, Entry>;
    } else {
      const legacy = parsed as Record<string, Entry>;
      store = {};
      for (const [k, e] of Object.entries(legacy)) {
        let subject: string, plugin: string;
        if (!k.includes(":")) { // M1 single-tenant "<plugin>"
          subject = "owner";
          plugin = k;
        } else { // legacy 2-part "subject:plugin"
          const idx = k.lastIndexOf(":");
          subject = k.slice(0, idx);
          plugin = k.slice(idx + 1);
        }
        const account = deriveAccount ? deriveAccount(plugin, e.jar) : "default";
        store[keyOf(subject, plugin, account)] = e;
        migrated++;
      }
      if (migrated) await persist();
    }
    console.log(`[vault] loaded ${Object.keys(store).length} jars (sealed)${migrated ? `, migrated ${migrated} → account-qualified` : ""}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

async function persist(): Promise<void> {
  if (!file || !key) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify({ v: 3, store }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt as BufferSource));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  await Deno.writeFile(file, out);
}

export async function setJar(subject: string, plugin: string, account: string, jar: Jar): Promise<void> {
  store[keyOf(subject, plugin, account)] = { jar, updatedAt: Date.now() };
  await persist();
}

// `account` omitted → back-compat resolution: exactly one jar for (subject, plugin)
// returns it; none returns null; MORE than one throws AmbiguousAccountError (never guess).
export function getJar(subject: string, plugin: string, account?: string): Jar | null {
  if (account !== undefined) return store[keyOf(subject, plugin, account)]?.jar ?? null;
  const matches = Object.entries(store).filter(([k]) => {
    const p = parseKey(k);
    return p.subject === subject && p.plugin === plugin;
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0][1].jar;
  throw new AmbiguousAccountError(subject, plugin, matches.map(([k]) => parseKey(k).account).sort());
}

// All accounts held by (subject, plugin) — replaces the single jarStatus. Empty when none.
export function jarsFor(subject: string, plugin: string): { account: string; updatedAt: number; count: number }[] {
  return Object.entries(store)
    .filter(([k]) => {
      const p = parseKey(k);
      return p.subject === subject && p.plugin === plugin;
    })
    .map(([k, e]) => ({ account: parseKey(k).account, updatedAt: e.updatedAt, count: Object.keys(e.jar).length }))
    .sort((a, b) => a.account.localeCompare(b.account));
}

// `account` omitted applies the same single/ambiguous rule as getJar (ambiguous → throws).
export async function deleteJar(subject: string, plugin: string, account?: string): Promise<boolean> {
  if (account !== undefined) {
    const k = keyOf(subject, plugin, account);
    if (!(k in store)) return false;
    delete store[k];
    await persist();
    return true;
  }
  const matches = Object.entries(store).filter(([k]) => {
    const p = parseKey(k);
    return p.subject === subject && p.plugin === plugin;
  });
  if (matches.length === 0) return false;
  if (matches.length === 1) {
    delete store[matches[0][0]];
    await persist();
    return true;
  }
  throw new AmbiguousAccountError(subject, plugin, matches.map(([k]) => parseKey(k).account).sort());
}

// Every (subject, plugin, account, jar) the scheduler should poll.
export function allJars(): { subject: string; plugin: string; account: string; jar: Jar }[] {
  return Object.entries(store).map(([k, e]) => {
    const { subject, plugin, account } = parseKey(k);
    return { subject, plugin, account, jar: e.jar };
  });
}

// #170 — the owner-readable directory over the SAME store allJars() walks: every
// (subject, plugin, account) with jarStatus()'s fields (updatedAt, count). Deliberately
// excludes the jar itself — this is a directory of current ownership, not a read. Consumers
// must use this instead of mining /api/audit: the audit ring buffer is bounded (#120) and
// evicts old `cookies.sync` entries while the jar is still perfectly fine.
export function allJarStatuses(): { subject: string; plugin: string; account: string; updatedAt: number; count: number }[] {
  return Object.entries(store)
    .map(([k, e]) => {
      const { subject, plugin, account } = parseKey(k);
      return { subject, plugin, account, updatedAt: e.updatedAt, count: Object.keys(e.jar).length };
    })
    .sort((a, b) =>
      a.subject.localeCompare(b.subject) || a.plugin.localeCompare(b.plugin) || a.account.localeCompare(b.account)
    );
}

export interface ExportedVaultEntry {
  plugin: string;
  account: string;
  jar: Jar;
  updatedAt: number;
  status?: "migrating";
}

// Export is intentionally a snapshot: callers receive the plaintext only in memory, then
// mark these same rows migrating after the encrypted envelope has been built successfully.
export function entriesForExport(subject: string): ExportedVaultEntry[] {
  return Object.entries(store)
    .filter(([k]) => parseKey(k).subject === subject)
    .map(([k, e]) => {
      const p = parseKey(k);
      return { plugin: p.plugin, account: p.account, jar: e.jar, updatedAt: e.updatedAt, ...(e.status ? { status: e.status } : {}) };
    })
    .sort((a, b) => a.plugin.localeCompare(b.plugin) || a.account.localeCompare(b.account));
}

export async function markMigrating(subject: string): Promise<number> {
  let count = 0;
  for (const [k, e] of Object.entries(store)) {
    if (parseKey(k).subject === subject) {
      e.status = "migrating";
      count++;
    }
  }
  if (count) await persist();
  return count;
}

export async function installEntries(subject: string, entries: ExportedVaultEntry[]): Promise<number> {
  for (const entry of entries) {
    if (!entry || typeof entry.plugin !== "string" || typeof entry.account !== "string" ||
      !entry.jar || typeof entry.jar !== "object") throw new Error("malformed vault entry");
    store[keyOf(subject, entry.plugin, entry.account)] = { jar: entry.jar, updatedAt: entry.updatedAt };
  }
  if (entries.length) await persist();
  return entries.length;
}

export async function deleteEntries(subject: string): Promise<number> {
  let count = 0;
  for (const k of Object.keys(store)) {
    if (parseKey(k).subject === subject) { delete store[k]; count++; }
  }
  if (count) await persist();
  return count;
}

export async function deleteMigrating(subject: string): Promise<number> {
  let count = 0;
  for (const [k, entry] of Object.entries(store)) {
    if (parseKey(k).subject === subject && entry.status === "migrating") {
      delete store[k];
      count++;
    }
  }
  if (count) await persist();
  return count;
}

// #132 — make a stranded jar legible. A jar is "stranded" when it exists under a subject
// the current wallet no longer uses (e.g. a retired extension wallet's userKey derived a
// different subject; every jar synced under it stops refreshing but is NOT "expired"). Today
// that reads identically to "never synced" / "cookies expired"; this is the structured seam
// that distinguishes the two so the operator/dashboard/popup can surface a re-sync instead of
// a generic failure. Owner-scoped at the handler (a subject must not see another identity's
// jars); the primitive itself is subject-agnostic and unit-testable in isolation.
export function strandedJars(
  currentSubject: string,
  plugin?: string,
): { subject: string; plugin: string; account: string; updatedAt: number; count: number }[] {
  return Object.entries(store)
    .filter(([k]) => {
      const p = parseKey(k);
      return p.subject !== currentSubject && (plugin === undefined || p.plugin === plugin);
    })
    .map(([k, e]) => {
      const p = parseKey(k);
      return { subject: p.subject, plugin: p.plugin, account: p.account, updatedAt: e.updatedAt, count: Object.keys(e.jar).length };
    })
    .sort((a, b) => a.plugin.localeCompare(b.plugin) || a.subject.localeCompare(b.subject) || a.account.localeCompare(b.account));
}
