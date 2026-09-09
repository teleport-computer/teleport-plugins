// A plugin wraps one site's unofficial API. The server holds the user's whole
// cookie jar for that site (synced by the extension) and the plugin turns it into
// list/fetch reads. This is the seam openfeedling's `shortCheck(cookies)` became.

import type { CapabilityStatement, Jar } from "../types.ts";

// Re-export Jar for backward compatibility with imports from "./plugins/types.ts"
export type { Jar };

export interface PluginItem {
  id: string;
  title: string;
  date?: string; // ISO
  meta?: Record<string, unknown>;
}

export interface PluginListOptions {
  page?: number;
  pageSize?: number;
}

export interface RedditListingItem {
  id: string;
  title: string;
  score: number;
  num_comments: number;
  created: number;
  permalink: string;
  url: string;
  author: string;
  subreddit?: string;
}

export interface RedditListingResult {
  items: RedditListingItem[];
  rateLimitHeaders: Record<string, string>;
}
export interface PluginTokenSource { origin: string; localStorage: string[]; jarKey: string; }

// #98: the amazon cart-substitute write. removeAsin is the active-cart line to remove;
// addAsin is the comparable replacement added at `qty`. Server-side enforced (price band +
// same category + qty bound) before the network write.
export interface SubstituteOp {
  removeAsin: string;
  addAsin: string;
  qty: number;
}
export interface SubstituteResult {
  removed: { asin: string; title: string; price: string; qty: number };
  added: { asin: string; title: string; price: string };
  before: unknown[]; // CartLine[] (kept loose to avoid a cycle into amazon.ts)
  after: unknown[];
  path: string; // which mutation path was used ("browser-path" primary; "server-replay" demoted/removed)
  // #103: the reified cart-write ops (cart.add + cart.remove) captured at the network layer
  // by /capture-trace over the browser-path actuation — the ground-truth evidence an
  // unofficial cart API is reified from (RFC 0001). Present on the browser path.
  ops?: unknown[];
}
// Account-level data — identity + named stats for the logged-in account (e.g. Reddit
// username + karma breakdown). The narrow renderable surface behind a scope ingredient
// like `reddit:karma`; returned by GET /api/:plugin/account.
export interface PluginAccountField {
  key: string; // stable machine key, e.g. "comment_karma"
  label: string; // human label, e.g. "Comment karma"
  value: string | number;
}
export interface PluginAccount {
  id: string; // stable account id (e.g. reddit username)
  label: string; // human label, e.g. "u/spez"
  fields: PluginAccountField[]; // ordered named account fields (e.g. karma breakdown)
}

export interface Plugin {
  id: string; // url-safe, e.g. "otter"
  label: string; // human, e.g. "ShapeRotator (Otter.ai)"
  cookieDomains: string[]; // extension grabs the WHOLE jar for these, e.g. [".otter.ai"]
  tokenSource?: PluginTokenSource;
  renderUrl?: string; // page to load for /screenshot; defaults to https://www.<cookieDomain>
  // #12: which execution path a read REQUIRES. "browser" (default "server" when unset) means
  // the read is only fulfillable through the Browser SPI carrying the real cookie — a
  // cookie-only instance (this pod) replaying over HTTP is bot-blocked and CANNOT serve it.
  // Surfaced verbatim by GET /api/plugins so listings/dashboards say so instead of reading
  // as a working connectable site. `available` is the instance's honest answer for this path
  // (false for browser-path plugins until the Browser SPI lands, #14).
  path?: "server" | "browser";
  available?: boolean;
  loggedIn(jar: Jar): boolean; // cheap presence check on a key cookie
  // Synchronous, offline account-id derivation from the jar (#111): the vault keys a jar
  // under `${subject}:${plugin}:${account}`, and `account` is DERIVED from the jar itself
  // (e.g. twitter's twid cookie) so one identity can hold multiple accounts per plugin
  // without a user-supplied label or a second oauth3 identity. MUST be deterministic +
  // side-effect-free; throws if a logged-in session can't yield a stable id (do not guess).
  // Distinct from the async `account?(jar)` stats read below (identity + karma, networked).
  accountId?(jar: Jar): string;
  listItems(jar: Jar, opts?: PluginListOptions): Promise<PluginItem[]>;
  fetchItem(jar: Jar, id: string): Promise<unknown>;
  // `liked?` used to live here (youtube:liked, #144) — one optional member of the interface every
  // plugin implements, for a read exactly ONE plugin serves. It now registers itself in
  // server/reads.ts instead. New read KINDS go there, not here: this interface is the credential
  // contract (which jar, is it logged in, what account), and it should stop growing a member every
  // time one site learns one new API shape. See the header of server/reads.ts.
  // Optional account-level read: identity + stats for the logged-in account (e.g. Reddit
  // username + karma breakdown). The narrow surface behind a scope ingredient like
  // `reddit:karma`. Gated at the handler's read chokepoint (readKind "account") like /items.
  account?(jar: Jar): Promise<PluginAccount>;
  subreddit?(jar: Jar, name: string, sort: string, limit: number, t?: string): Promise<RedditListingResult>;
  search?(jar: Jar, query: string, subreddit: string | undefined, sort: string, limit: number): Promise<RedditListingResult>;
  quota?(jar: Jar): Promise<unknown>;
  // Optional live-follow surface: the currently-live item's recent segments (with
  // monotonic `order` for incremental polling) plus any shared-screen frames.
  live?(jar: Jar, after: number): Promise<unknown>;
  // Optional binary frame proxy: fetch one site-CDN image with the jar (the app can't
  // reach the CDN itself — it only holds a scoped token, never the cookie).
  fetchFrame?(jar: Jar, url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  // Optional write primitive (the edit-on-behalf surface). Symmetric with fetchItem.
  // Gated at the handler by owner OR a structured cap (e.g. write:event:<id>); plugins
  // that don't expose writes leave this undefined.
  editItem?(jar: Jar, id: string, patch: unknown): Promise<unknown>;
  // Optional cart-line substitute (amazon:cart-substitute, #98): remove one ASIN, add one
  // comparable ASIN within a price band + same category. Server-side enforced; gated by owner
  // OR the `amazon:cart-substitute` cap. Throws SubstituteDeniedError (code "denied") for any
  // shape the cap must not permit; the handler maps that to 403.
  substitute?(jar: Jar, op: Partial<SubstituteOp>): Promise<SubstituteResult>;
  // Optional usage/quota read: provider-side usage numbers for the logged-in account
  // (e.g. z.ai GLM Coding Plan quota %). Behind a scope ingredient like `zai:usage-read`.
  // Gated at the handler read chokepoint (readKind "quota"); returned by GET /api/:plugin/quota.
  quota?(jar: Jar): Promise<unknown>;

  // RFC 0007 §2.4: capability statement + sub-capabilities
  capability?: CapabilityStatement; // the plugin-wide (b2) statement
  scopes?: Record<string, { // named narrow attenuations (b1)
    statement: CapabilityStatement;
    read(jar: Jar): Promise<unknown>;
  }>;
}

export function cookieHeader(jar: Jar): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}
