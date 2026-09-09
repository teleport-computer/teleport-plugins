import { loadSites } from "./plugins/declarative.ts";

// Composable "scope ingredients" — the credential dial made legible and enforceable.
// A token's caps may name one or more ingredients; each ingredient whitelists a set of
// read kinds (the endpoint chokepoints in handler.ts). A token that carries NO ingredient
// cap is unrestricted (scopeReads → null) so owner + every legacy token keep reading
// everything — backward compatible. A token that carries ingredient caps is confined to
// the UNION of those ingredients' reads. RFC 0003/0004 (attenuated delegation).

export const SCOPE_INGREDIENTS: Record<string, { plugin: string; reads: string[]; label: string }> =
  {
    "otter:live-follow": {
      plugin: "otter",
      reads: ["live", "frame"],
      label:
        "read-only · the current live meeting · not your conversation list, transcript text, or recap",
    },
    "reddit:karma": {
      plugin: "reddit",
      reads: ["account"],
      label:
        "read-only · your Reddit account identity (username) and karma (comment + link) · not your saved posts, feed, votes, or messages",
    },
    "reddit:read": {
      plugin: "reddit",
      reads: ["sub", "search"],
      label:
        "read-only · subreddit listings and search fetched as your Reddit session · not your account, saved posts, feed, votes, or messages",
    },
    "codex:usage-read": {
      plugin: "codex",
      reads: ["quota"],
      label: "read-only · your ChatGPT/Codex 5-hour and weekly usage windows · not prompts, responses, or account credentials",
    },
    // #88: novel consumed scopes seeded by the composable utilities (feedling, calendar-share).
    // Each maps to a real read chokepoint in handler.ts, so a token carrying the cap is
    // confined exactly like otter:live-follow / reddit:karma — the consumed claim is enforced,
    // not hollow (RFC 0004).
    "youtube:history": {
      plugin: "youtube",
      reads: ["feed"], // the /feed reconstruction of watch history (videos + Shorts)
      label:
        "read-only · your watch history (videos and Shorts) · not your liked videos, subscriptions, comments, playlists, or uploads",
    },
    // #144: the liked-videos read. A distinct read chokepoint (readKind "liked" at
    // /api/youtube/liked) from watch history, so a history-only token CANNOT reach liked
    // videos and vice versa — the confinement is the point. The label lists what's OUT so the
    // approve dialog can't promise more than the cap grants (RFC 0004 anti-hollow-green).
    "youtube:liked": {
      plugin: "youtube",
      reads: ["liked"], // GET /api/youtube/liked — the owner's liked-videos playlist (LL)
      label:
        "read-only · your liked videos (id, title, channel, length) · not your watch history, subscriptions, comments, playlists, or uploads",
    },
    "calendar:free-busy": {
      plugin: "google-calendar",
      reads: ["items"], // the upcoming-events list (the free/busy surface) via /items
      label:
        "read-only · your upcoming events (the free/busy surface) · not event bodies or attendees, and no writes",
    },
    // #92: the first cart/commerce scope. A cart-share friend holds this cap to read the
    // owner's real Amazon cart line items (name, price, qty, ASIN) — confined to the /items
    // read chokepoint, so it can't reach /screenshot, /jar, or any write surface.
    "amazon:cart-read": {
      plugin: "amazon",
      reads: ["items"],
      label:
        "read-only · your Amazon cart line items (name, price, qty, ASIN) · not your address, payment, order history, or checkout",
    },
    // #98: the cart-write cap. A cart-share friend holds this to substitute ONE cart line
    // (remove an ASIN, add a comparable ASIN within a price band + same category). reads:[]
    // is load-bearing — it makes scopeReads(["amazon:cart-substitute"]) an EMPTY set, so a
    // substitute-only token is denied at EVERY read chokepoint (it cannot read the cart,
    // order history, address, or payment); the friend view reads via a separate amazon:cart-
    // read cap. The write itself is gated by verifyCap at the substitute route + the
    // server-side price-band/category/qty enforcement in the plugin (SubstituteDeniedError).
    "amazon:cart-substitute": {
      plugin: "amazon",
      reads: [],
      label:
        "write · substitute ONE cart line — remove an ASIN, add ONE comparable ASIN within a price band and the same category · CANNOT check out, add arbitrary items, change address/payment, raise quantity, or read your cart/order history",
    },
    // #76: the first usage/metering scope. A token confined to the /quota read chokepoint —
    // your z.ai GLM Coding Plan usage numbers, nothing that touches the key or coding traffic.
    "zai:usage-read": {
      plugin: "zai",
      reads: ["quota"],
      label:
        "read-only · your z.ai Coding Plan usage numbers (5-hour and weekly quota %, tokens, per-model) · not your API key, prompts, code, or account settings",
    },
  };

// Per-plugin capability statements (RFC 0009 step 1) — the operator-authored sentence shown
// on the approve page for informed consent: what a token for this plugin CAN read and CANNOT
// touch. The approve dialog renders `pluginCapability(req.plugin).statement` straight from
// here, and GET /api/scopes surfaces the same list, so the shown sentence can't drift from
// this source (RFC 0004 anti-hollow-green). One entry per in-tree plugin under server/plugins/.
export const PLUGIN_CAPABILITIES: Record<string, { plugin: string; statement: string }> = {
  otter: {
    plugin: "otter",
    statement:
      "CAN read your conversation list, each transcript, the current live meeting's segments and shared-screen frames, and a logged-in screenshot of otter.ai. CANNOT edit, delete, or share anything.",
  },
  youtube: {
    plugin: "youtube",
    statement:
      "CAN read your watch history (videos and Shorts, each flagged isShort), your liked videos (id, title, channel, length), and a logged-in screenshot of youtube.com. CANNOT like, subscribe, comment, remove from history, or upload.",
  },
  reddit: {
    plugin: "reddit",
    statement:
      "CAN read your saved posts and comments (and each item's full body/url), subreddit listings and search results, your account identity and karma (comment + link), and a logged-in screenshot of reddit.com. CANNOT save, vote, post, comment, or edit.",
  },
  codex: {
    plugin: "codex",
    statement: "CAN read your ChatGPT/Codex plan usage windows and reset times. CANNOT read prompts, responses, or expose the bearer credential.",
  },
  nytimes: {
    plugin: "nytimes",
    statement:
      "BROWSER-PATH — reads only succeed via the browser (Teleport Computer), not a server-side replay. CAN read your Reading List (saved articles) and a logged-in screenshot of nytimes.com. CANNOT save, subscribe, or edit.",
  },
  twitter: {
    plugin: "twitter",
    statement:
      "BROWSER-PATH — no frozen API. CAN read a logged-in screenshot of your x.com timeline (the only read). CANNOT read the timeline as structured data, tweet, like, retweet, follow, or DM.",
  },
  "google-calendar": {
    plugin: "google-calendar",
    statement:
      "CAN read your upcoming events and a logged-in screenshot of calendar.google.com; a token MAY also carry a write:event:<id> cap to edit ONE named event. CANNOT create or delete events, or edit any event not named in its caps.",
  },
  amazon: {
    plugin: "amazon",
    statement:
      "CAN read your Amazon cart line items and a logged-in screenshot of your cart; a token MAY also carry an `amazon:cart-substitute` cap to swap ONE cart line for a comparable item within a price band and the same category. CANNOT check out, change address/payment, add arbitrary items, raise quantity, or read order history.",
  },
  zai: {
    plugin: "zai",
    statement:
      "CAN read your z.ai GLM Coding Plan usage numbers (5-hour and weekly quota %, total tokens, per-model breakdown, search/reader usage). CANNOT see your API key, prompts, code, or account settings, and can make no changes.",
  },
};

// Declarative longtail sites (server/plugins/sites/*.json) contribute their scope
// ingredients + capability sentence the SAME way in-tree plugins do — merged into the
// two ledgers above, so the gate (scopeReads), approve page, and /api/scopes enforce and
// render them identically. A manifest scope is exactly as real as reddit:karma.
{
  const { ingredients, capabilities } = loadSites();
  Object.assign(SCOPE_INGREDIENTS, ingredients);
  Object.assign(PLUGIN_CAPABILITIES, capabilities);
}

// Runtime registration of a declarative site's scopes + capability (POST /api/sites, via
// sites.ts) — merged into the SAME ledgers, so a dynamically-added site's scope enforces
// and renders identically to an in-tree one. Unregister removes them again.
export function registerSiteScopes(
  ingredients: Record<string, { plugin: string; reads: string[]; label: string }>,
  capabilities: Record<string, { plugin: string; statement: string }>,
): void {
  Object.assign(SCOPE_INGREDIENTS, ingredients);
  Object.assign(PLUGIN_CAPABILITIES, capabilities);
}
export function unregisterSiteScopes(pluginId: string): void {
  for (const id of Object.keys(SCOPE_INGREDIENTS)) if (SCOPE_INGREDIENTS[id].plugin === pluginId) delete SCOPE_INGREDIENTS[id];
  delete PLUGIN_CAPABILITIES[pluginId];
}

// The full plugin-capability ledger (one statement per in-tree plugin). Public/read-only.
export function pluginCapabilities(): { plugin: string; statement: string }[] {
  return Object.values(PLUGIN_CAPABILITIES);
}
// The exact enforced statement for one plugin; undefined when unknown (no drift to a made-up sentence).
export function pluginCapability(plugin: string): { plugin: string; statement: string } | undefined {
  const c = PLUGIN_CAPABILITIES[plugin];
  return c ? { ...c } : undefined;
}

// The enforced ingredient ledger, surfaced for the UX layer (RFC 0004 — closure-can't-drift):
// the scope sentence shown to a user MUST come from here, not an app-authored string, so
// the displayed claim is provably what's enforced at the gate. Public/read-only by design
// (the labels already appear verbatim in the gate's 403 response).
export function scopeIngredients(): { id: string; plugin: string; reads: string[]; label: string }[] {
  return Object.entries(SCOPE_INGREDIENTS).map(([id, ing]) => ({ id, ...ing }));
}
export function scopeIngredient(
  id: string,
): { id: string; plugin: string; reads: string[]; label: string } | undefined {
  const ing = SCOPE_INGREDIENTS[id];
  return ing ? { id, ...ing } : undefined;
}

// --- App scope declarations (#88): apps declare what they CONSUME and OFFER. ---
// A utility declares the enforced scope ingredient(s) it CONSUMES (ids that MUST resolve to
// SCOPE_INGREDIENTS above — anti-hollow-green: the consumed claim is provably what the gate
// enforces, never a second app-authored string) and, where it derives a new capability, the
// novel scope it OFFERS. Offers are app-declared PRODUCTS (a digest, a recap) computed from
// consumed reads — NOT gate-enforced endpoint reads — so their labels are app-authored and
// surfaced as such, distinct from the enforced consumed labels. This is what lets a reviewer
// read the pod as a set of composable capability-utilities rather than one-off demos.
export interface AppOffer {
  id: string; // the novel scope this app produces (e.g. "feedling:digest")
  label: string; // app-authored description of the derived capability
}
export interface AppDeclaration {
  id: string; // app id (matches ConnectReq.app / listing id)
  name: string; // human label for the card
  consumes: string[]; // enforced scope-ingredient ids (each must be in SCOPE_INGREDIENTS)
  offers: AppOffer[]; // novel scopes this app produces (declared, not gate-enforced)
  note?: string; // one-line composition sentence for the reviewer
}
export const APP_DECLARATIONS: AppDeclaration[] = [
  {
    id: "feedling",
    name: "Feedling — watch-history digest",
    consumes: ["youtube:history"],
    offers: [
      { id: "feedling:digest", label: "a daily digest of what you watched (videos vs Shorts), derived from your history" },
    ],
    note: "reads your YouTube watch history; emits a derived digest no other app can see",
  },
  {
    id: "otterpilot",
    name: "OtterPilot — live-meeting recap",
    consumes: ["otter:live-follow"],
    offers: [
      { id: "otterpilot:recap", label: "a recap of the current live meeting, derived from live segments + shared-screen frames" },
    ],
    note: "follows the currently-live meeting only; emits a derived recap",
  },
  {
    id: "reddit-karma",
    name: "Reddit karma — account read",
    consumes: ["reddit:karma"],
    offers: [],
    note: "reads your account identity + karma only; a pure consumer (no offers)",
  },
  {
    id: "calendar-share",
    name: "Calendar share — free/busy",
    consumes: ["calendar:free-busy"],
    offers: [],
    note: "the clearest novel-scope candidate: your upcoming free/busy, nothing else",
  },
  {
    id: "zai-usage",
    name: "z.ai usage — Coding Plan quotas",
    consumes: ["zai:usage-read"],
    offers: [],
    note: "reads your z.ai Coding Plan usage numbers only; also feeds the swarm quota gate provider-truth",
  },
];

// A consumed scope resolved against the enforced ledger. enforced:false (not silently dropped)
// when an app names an id that isn't in SCOPE_INGREDIENTS — the operator sees the gap instead
// of a hollow claim.
export interface AppConsumedScope {
  id: string;
  enforced: boolean;
  plugin?: string;
  reads?: string[];
  label?: string;
}
export interface ResolvedAppDeclaration extends AppDeclaration {
  consumedScopes: AppConsumedScope[]; // consumes[], resolved to the enforced ingredient records
}

// The app → {consumes, offers} composition graph, each consumed id resolved to its enforced
// ingredient record so the UX layer renders the gate-enforced label (no drift). Surfaced at
// GET /api/scopes alongside the ingredient + plugin ledgers (one public source).
export function appDeclarations(): ResolvedAppDeclaration[] {
  return APP_DECLARATIONS.map((a) => ({
    ...a,
    consumedScopes: a.consumes.map((id) => {
      const ing = SCOPE_INGREDIENTS[id];
      return ing
        ? { id, enforced: true, plugin: ing.plugin, reads: ing.reads, label: ing.label }
        : { id, enforced: false };
    }),
  }));
}

// null = unrestricted (no scope ingredient present). Otherwise the union of allowed reads.
export function scopeReads(caps?: string[]): Set<string> | null {
  const named = (caps ?? []).filter((c) => c in SCOPE_INGREDIENTS);
  if (named.length === 0) return null;
  const reads = new Set<string>();
  for (const c of named) for (const r of SCOPE_INGREDIENTS[c].reads) reads.add(r);
  return reads;
}

export function scopeLabel(caps?: string[]): string {
  return (caps ?? []).filter((c) => c in SCOPE_INGREDIENTS).map((c) => SCOPE_INGREDIENTS[c].label)
    .join(" · ");
}
