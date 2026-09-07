// A READ IS DATA, NOT A METHOD ON A SHARED INTERFACE.
//
// Until 2026-08-19 every new *kind* of read a site could serve became a new optional member of
// the one `Plugin` interface every plugin implements, plus its own bespoke route in handler.ts,
// plus an ingredient in scopes.ts. Adding YouTube's liked-videos read (#144) cost 342 insertions
// across four core files — one of them the interface shared by all ten plugins — and an attested
// core deploy, to read a different list from a site we already hold the credential for.
//
// The interface had become a union of single-use methods rather than an abstraction: of its nine
// capability methods, SIX were implemented by exactly one plugin (`accountId` twitter, `account`
// reddit, `liked` youtube, `live` + `fetchFrame` otter, `substitute` amazon), while `zai` and
// `codex` were forced to implement `listItems`/`fetchItem` only to throw, because they are
// quota-only and the interface demanded them anyway. It could only ever grow.
//
// The seam was in the wrong place. Three things vary independently and were welded together:
//   the CREDENTIAL  — one jar per (site, account). Singular, stable, worth refining.
//   the READ        — one API shape. MANY per site, unstable, plural by nature.
//   the TRUST RULE  — which scope ingredient gates it.
// Because they were welded, varying the read forced a change to the credential's TYPE.
//
// This registry unwelds them. A named read declares which plugin's jar it needs, which readKind
// the gate confines it to, and how to run it. Registering one is a module-level call (hand-written
// plugins) or a manifest entry (declarative sites, RFC 0012) — never an interface edit, and for a
// runtime-registered site never a deploy either. handler.ts serves all of them through ONE generic
// route, so the route table stops growing too.
//
// What this does NOT change: the gate. A registered read is confined by exactly the same
// `gateRead(token, plugin, readKind, bearer)` chokepoint as a hand-written one, so a scope
// ingredient over a registered read is exactly as real as `reddit:karma` — never hollow.

import { Jar } from "./plugins/types.ts";

export interface NamedRead {
  plugin: string; // the plugin whose jar this read replays
  kind: string; // the readKind the gate confines it to; scopes.ts grants it by name
  label: string; // what it returns, for the capability ledger and the approve page
  run(jar: Jar): Promise<unknown>;
}

// Kinds handler.ts still serves with a bespoke route. Registering one of these would create a
// read whose behaviour depends on route order — silently shadowed, or silently shadowing. Fail at
// registration instead: this is the one thing a generic route cannot detect at request time.
const RESERVED = new Set([
  "items",
  "item",
  "account",
  "feed",
  "live",
  "frame",
  "quota",
  "screenshot",
  "jar",
  "sites",
  "tokens",
  "scopes",
  "connect",
  "challenge",
  "cookies",
]);

const reads = new Map<string, NamedRead>();
const key = (plugin: string, kind: string) => `${plugin}/${kind}`;

export function registerRead(r: NamedRead): void {
  if (!/^[a-z0-9-]+$/.test(r.kind)) {
    throw new Error(`read kind '${r.kind}' must be url-safe [a-z0-9-]`);
  }
  if (RESERVED.has(r.kind)) {
    throw new Error(
      `read kind '${r.kind}' is served by a bespoke route — pick another name or migrate that route here`,
    );
  }
  const k = key(r.plugin, r.kind);
  // A second registration of the same (plugin, kind) is a bug, not an override: two reads would
  // answer the same URL and which one you got would depend on import order.
  if (reads.has(k)) throw new Error(`read ${k} is already registered`);
  reads.set(k, r);
}

export function getRead(plugin: string, kind: string): NamedRead | undefined {
  return reads.get(key(plugin, kind));
}

export function readsOf(plugin: string): NamedRead[] {
  return [...reads.values()].filter((r) => r.plugin === plugin);
}

// Runtime-registered sites can be removed (DELETE /api/sites/:id); their reads must go with them,
// or the URL keeps answering from a plugin that no longer exists.
export function unregisterReads(plugin: string): number {
  let n = 0;
  for (const [k, r] of [...reads.entries()]) {
    if (r.plugin === plugin) {
      reads.delete(k);
      n++;
    }
  }
  return n;
}
