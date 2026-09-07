// App-authorization handshake (auth layer 2 — the per-user grant). An app calls
// POST /api/connect to ask for access to a plugin; the user lands on the approve
// page, grants, and a scoped token is minted and handed back to the app via its
// requestId. The app never holds the owner secret.

import { listTokens, mint, revoke } from "./tokens.ts";
import { recordTokenUse } from "./stepup.ts";
import { route } from "./routing.ts";
import type { RouteResult } from "./types.ts";

export interface ConnectReq {
  requestId: string;
  plugin: string;
  subject?: string;
  app?: string;
  caps?: string[]; // requested capabilities (e.g. "jar", "write:event:<id>"); surfaced on the approve page for consent
  // RFC 0007 §1.1: requested attenuation (breadth axis)
  scope?: string;
  // RFC 0007 §1.1: verifiability claim (URL of td-0020 evidence bundle)
  attestation?: string;
  // #111: bind the minted token to ONE account's jar when the approver holds several for
  // this plugin. Resolved/validated at approve time (the approver's jars are what's read).
  account?: string;
  status: "pending" | "approved" | "denied";
  token?: string;
  createdAt: number;
  // RFC 0007 §1.4: routing decision cached at request time
  routeResult?: RouteResult;
}

let file = "";
let reqs: Record<string, ConnectReq> = {};

async function persist(): Promise<void> {
  if (file) await Deno.writeTextFile(file, JSON.stringify(reqs));
}

export async function initConnect(dir: string): Promise<void> {
  if (!dir) return;
  file = `${dir}/connect.json`;
  try { reqs = JSON.parse(await Deno.readTextFile(file)); }
  catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
}

// createConnect records a pending grant. The layer-1 listing gate (listing.ts `gate()`)
// is enforced upstream in the handler and stays the authoritative ledger; here we also
// compute the RFC 0007 routing decision (friction) so the approve page can render it.
export async function createConnect(
  plugin: string,
  subject?: string,
  app?: string,
  caps?: string[],
  scope?: string,
  attestation?: string,
  account?: string,
): Promise<ConnectReq> {
  const requestId = `req-${crypto.randomUUID().replace(/-/g, "")}`;
  const routeResult = route(plugin, scope, attestation);
  reqs[requestId] = {
    requestId,
    plugin,
    subject,
    app,
    ...(caps?.length ? { caps } : {}),
    scope,
    attestation,
    status: "pending",
    createdAt: Date.now(),
    routeResult,
    ...(account ? { account } : {}),
  };
  await persist();
  return reqs[requestId];
}

export function getConnect(id: string): ConnectReq | undefined { return reqs[id]; }

// The token is bound to the APPROVER's identity (whose jar it will read), not the
// app-supplied attribution. r.subject stays as the app's display hint.
export async function approveConnect(id: string, approver: string): Promise<ConnectReq | null> {
  const r = reqs[id];
  if (!r || r.status !== "pending") return null;
  // A reconnect is a replacement grant for the same user/plugin/app tuple. Revoke the
  // prior live grants before minting the replacement, retaining their rows as an audit trail.
  const app = r.app ?? "";
  for (const prior of listTokens()) {
    if (
      !prior.revokedAt && prior.plugin === r.plugin && prior.subject === approver &&
      (prior.app ?? "") === app
    ) {
      await revoke(prior.token);
    }
  }
  // The minted token carries the requested caps (e.g. write:event:<id>) only after the
  // approver sees them on the consent screen — informed consent for a write capability.
  // #111: it also carries the requested account, binding the read to that account's jar.
  const t = await mint(r.plugin, approver, r.app, r.caps, r.account);
  // RFC 0005 step-up: an owner-approved connect IS the out-of-band consent. Pre-mark the
  // freshly minted token as used so its first read does not trip step-up again (the owner
  // just granted it on the approve screen). oauth3-server#106 acceptance bullet 2.
  await recordTokenUse(t.token, r.plugin);
  r.status = "approved";
  r.token = t.token;
  await persist();
  return r;
}

export async function denyConnect(id: string): Promise<ConnectReq | null> {
  const r = reqs[id];
  if (!r) return null;
  if (r.status === "pending") { r.status = "denied"; await persist(); }
  return r;
}

// What the polling app sees — token only once approved.
export function statusOf(r: ConnectReq): { status: string; token?: string } {
  return r.status === "approved" ? { status: "approved", token: r.token } : { status: r.status };
}
