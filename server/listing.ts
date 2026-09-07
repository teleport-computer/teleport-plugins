// Layer-1 listing gate — auth layer 1 (app-store admission). RFC 0003 delegation continuum.
// A static, hand-curated catalog that gates POST /api/connect. Apps must be listed to
// request access; listed apps may request scope up to their maxScope (MVP: all "read").
// Unlisted or overly-broad requests are refused or shunted to dev-mode (explicit).

import { allPlugins } from "./plugins/registry.ts";

/** Breadth levels: read (scoped) vs raw (zero attenuation). MVP: read is the only mintable delegation. */
export type Scope = "read" | "raw";

/** Discharge levels (RFC 0004 ladder). MVP: rung 1 only (listed/analysis-pending). */
export type Discharge = 1 | 2 | 3;

/** A listed app with its permitted breadth and trust provenance. */
export interface Listing {
  /** App identifier (self-declared; attestation binding is future work). */
  appId: string;
  /** Plugins this app may request access to. Empty array = any plugin. */
  allowedPlugins: string[];
  /** Maximum scope this app may request. Requests exceeding this trigger dev-mode. */
  maxScope: Scope;
  /** Free-text capability statement (prose only; generative/closure-checked deferred). */
  statement: string;
  /** Discharge level: 1 = listed/analysis-pending; 2-3 = future (need attestation surface). */
  discharge: Discharge;
}

/** Gate decision: allow (proceed to connect), dev-mode (explicit affordance), or refuse. */
export type GateDecision = { decision: "allow" } | { decision: "devmode"; reason: string } | { decision: "refuse"; reason: string };

/** MVP static listing. Curated by operator; loaded before the connect gate runs. */
export const STATIC_LISTING: Listing[] = [
  {
    appId: "demo-app",
    allowedPlugins: ["otter", "youtube", "reddit", "nytimes", "amazon"],
    maxScope: "read",
    statement: "Demo app for the oauth3-server instance. Reads items from supported plugins.",
    discharge: 1,
  },
  {
    appId: "cart-share",
    allowedPlugins: ["amazon"],
    maxScope: "read",
    statement:
      "Lets a friend read your Amazon cart to suggest organic substitutions under a scoped, substitute-only capability — reads cart line items only, never checkout, address, payment, or order history.",
    discharge: 1,
  },
  {
    appId: "reddit-karma",
    allowedPlugins: ["reddit"],
    maxScope: "read",
    statement: "Shows your Reddit karma and saved items under a scoped, revocable read token — read-only, never posts.",
    discharge: 1,
  },
  {
    appId: "timeline-peek",
    allowedPlugins: ["twitter"],
    maxScope: "read",
    statement: "Renders a read-only peek of your X timeline under a scoped, revocable read token — never posts or follows.",
    discharge: 1,
  },
  {
    appId: "otterscope",
    allowedPlugins: ["otter"],
    maxScope: "read",
    statement: "Reads your Otter meeting transcripts under a scoped, revocable read token to render highlights — read-only.",
    discharge: 1,
  },
  {
    appId: "feedling-web",
    allowedPlugins: ["youtube"],
    maxScope: "read",
    statement: "Reads your YouTube feed items under a scoped, revocable read token to render a feed — read-only.",
    discharge: 1,
  },
  {
    appId: "zai-usage",
    allowedPlugins: ["zai"],
    maxScope: "read",
    statement: "Reads your z.ai GLM Coding Plan usage (quota %, tokens, per-model) under a scoped, revocable read token — read-only, never your API key or prompts.",
    discharge: 1,
  },
];

/**
 * Resolve a listing entry by app ID. Returns undefined if not listed.
 */
export function getListing(appId: string): Listing | undefined {
  return STATIC_LISTING.find((e) => e.appId === appId);
}

/**
 * The listing gate: checks whether an app may request a given plugin/scope.
 * Returns a GateDecision indicating allow, dev-mode, or refuse.
 *
 * Per RFC 0003 friction matrix:
 * - attested in-TEE + narrow → trivial
 * - attested in-TEE + broad → appropriate
 * - opaque/external + narrow → low bar
 * - opaque/external + broad → dev-mode (explicit, human owns it)
 *
 * MVP: all requests are opaque/external (no attestation surface yet). Breadth is
 * coarse (read vs raw). Listing is the only verifiability signal (on-list = 1).
 */
export function gate(
  appId: string,
  pluginId: string,
  requestedScope: Scope = "read",
): GateDecision {
  const listing = getListing(appId);

  // Unlisted app → refuse (AC1)
  if (!listing) {
    return { decision: "refuse", reason: `App "${appId}" is not listed. Add it via the operator or use dev-mode.` };
  }

  // Check plugin allowlist. Empty array = any plugin.
  if (listing.allowedPlugins.length > 0 && !listing.allowedPlugins.includes(pluginId)) {
    return { decision: "refuse", reason: `App "${appId}" is not allowed to access plugin "${pluginId}".` };
  }

  // Check scope. Exceeding maxScope → dev-mode (AC3)
  if (requestedScope === "raw" && listing.maxScope !== "raw") {
    return {
      decision: "devmode",
      reason: `App "${appId}" requested raw credential access (scope:raw) but is only listed for scope:${listing.maxScope}.`,
    };
  }

  // All checks passed → allow (AC1)
  return { decision: "allow" };
}

/**
 * Format a gate decision for audit logging. Includes the discharge level (if listed).
 */
export function formatAuditDecision(
  appId: string,
  pluginId: string,
  requestedScope: Scope,
  decision: GateDecision,
): { app: string; plugin: string; requestedScope: Scope; discharge: number | null; decision: string } {
  const listing = getListing(appId);
  return {
    app: appId,
    plugin: pluginId,
    requestedScope,
    discharge: listing?.discharge ?? null,
    decision: decision.decision,
  };
}
