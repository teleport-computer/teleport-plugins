// Runtime step-up authorization gate (RFC 0005 P0).
// A third auth layer at invocation time: anomalous reads trip a guard that
// pauses and asks the user to confirm out-of-band. App sees "challenge pending"
// and retries. The approval happens on a channel the app has no token for.

import { audit } from "./audit.ts";

export interface Challenge {
  challengeId: string;
  plugin: string;
  item: string; // "list" or item id
  token: string; // the token being challenged (stripped)
  app?: string; // app attribution from token
  signal: string; // what tripped the guard
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: number;
  expiresAt: number;
}

// In-memory challenge store (local-jar only). Pending challenges are deliberately
// ephemeral: a restart drops any in-flight challenge, which is correct — a read that was
// never approved simply re-challenges. The DURABLE state is the consented-token set below.
const challenges = new Map<string, Challenge>();

// Token usage tracking for the "first use" signal. THIS is the durable consent ledger: a
// token present here has been consented to (used by a successful read, approved via a
// step-up challenge, or minted through an owner-approved connect) and must never
// re-challenge. Persisted to the data volume so a core restart does not wipe approvals
// (oauth3-server#106: the owner was being re-challenged on every redeploy).
const tokenFirstUse = new Map<string, boolean>();

// TTL: challenge expires after 5 minutes
const CHALLENGE_TTL = 5 * 60 * 1000;

let file = "";

async function persist(): Promise<void> {
  if (file) await Deno.writeTextFile(file, JSON.stringify(Object.fromEntries(tokenFirstUse)));
}

// Load the consented-token set from the data volume on boot, so approvals survive core
// restarts. Idempotent: safe to call once per process in init().
export async function initStepup(dir: string): Promise<void> {
  if (!dir) return;
  file = `${dir}/stepup.json`;
  try {
    const data = JSON.parse(await Deno.readTextFile(file));
    if (data && typeof data === "object") {
      for (const k of Object.keys(data)) tokenFirstUse.set(k, true);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

// TEST-ONLY: drop in-memory state and detach from disk, so a round-trip test can simulate
// a fresh process restart against the same data dir. Not wired into any production path.
export function _resetForTest(): void {
  tokenFirstUse.clear();
  challenges.clear();
  file = "";
}

function generateId(): string {
  return `chal-${crypto.randomUUID().replace(/-/g, "")}`;
}

// A token minted this recently still carries live consent: the user clicked Connect and
// approved the grant seconds ago, and this read is that grant being exercised. Re-asking them
// confirms the same authority to itself. The signal worth catching is the OTHER first use — a
// token that sat idle and then woke up, where the consent is cold and the read is unattended.
const FRESH_CONSENT_MS = 2 * 60 * 1000;

// Score the invocation and return a decision.
// Returns: { decision: "approve" | "reject" | "challenge", signal?: string }
export function score(
  tokenStr: string, // the full token
  plugin: string,
  item: string,
  app?: string,
  mintedAt?: number // token.createdAt; omitted -> treat consent as cold
): { decision: "approve" | "reject" | "challenge"; signal?: string } {
  // First use of a token is the P0 signal — but only when consent has gone cold. First use is
  // otherwise true of EVERY token, so challenging on it alone gated 100% of reads rather than
  // anomalous ones, and (with no wallet prompt shipped) dead-ended every app on its first read.
  const tokenKey = `${plugin}-${tokenStr.slice(0, 16)}`;
  const isFirstUse = !tokenFirstUse.has(tokenKey);

  if (isFirstUse) {
    if (mintedAt !== undefined && Date.now() - mintedAt <= FRESH_CONSENT_MS) {
      return { decision: "approve" };
    }
    return { decision: "challenge", signal: "first_token_use" };
  }

  // Otherwise auto-approve
  return { decision: "approve" };
}

// Create a pending challenge. Call this when score returns "challenge".
export function createChallenge(
  plugin: string,
  item: string,
  tokenStr: string,
  app: string | undefined,
  signal: string
): Challenge {
  const challengeId = generateId();
  const now = Date.now();
  const chal: Challenge = {
    challengeId,
    plugin,
    item,
    token: tokenStr.slice(0, 16), // store stripped prefix only
    app,
    signal,
    status: "pending",
    createdAt: now,
    expiresAt: now + CHALLENGE_TTL,
  };
  challenges.set(challengeId, chal);
  return chal;
}

// Get a challenge by id. Returns null if not found or expired.
export function getChallenge(id: string): Challenge | null {
  const chal = challenges.get(id);
  if (!chal) return null;
  // Auto-expire
  if (Date.now() > chal.expiresAt && chal.status === "pending") {
    chal.status = "expired";
    audit("stepup.expired", { challengeId: id, plugin: chal.plugin, signal: chal.signal });
  }
  return chal;
}

// Every still-pending challenge (expiring any that aged out first). The wallet polls this to
// DISCOVER challenges on its own: if the app handed the wallet the challengeId, the approval
// would ride the same channel as the request it is meant to confirm, which is the one thing
// RFC 0005 is trying to avoid. Callers filter to the acting subject.
export function pendingChallenges(): Challenge[] {
  for (const id of challenges.keys()) getChallenge(id); // side effect: auto-expire
  return [...challenges.values()].filter((c) => c.status === "pending");
}

// Record that a token has been used (called after a successful read, after a step-up
// approval, or at connect-mint). Marks the token as consented in the DURABLE ledger so a
// later restart does not re-challenge it.
export async function recordTokenUse(tokenStr: string, plugin: string): Promise<void> {
  const tokenKey = `${plugin}-${tokenStr.slice(0, 16)}`;
  tokenFirstUse.set(tokenKey, true);
  await persist();
}

// Approve a challenge. Returns the challenge if found and pending, else null.
// The approver is the session subject (must not be the app itself).
export async function approveChallenge(id: string, approver: string, approverIsOwner: boolean): Promise<Challenge | null> {
  const chal = challenges.get(id);
  if (!chal || chal.status !== "pending") return null;

  // App bearer must not self-approve
  // Check if the approver's session matches the app attribution
  // This is enforced at the handler level (subjectOf checks); here we just record
  chal.status = "approved";
  // Clear the token's first-use flag so the app's NEXT read scores "approve" instead of
  // re-challenging. Without this, an approved challenge never lets a read through — the token
  // is stuck challenging forever (score() only checks first-use). chal.token is already the
  // 16-char prefix; recordTokenUse keys on the same slice.
  await recordTokenUse(chal.token, chal.plugin);
  audit("stepup.approved", {
    challengeId: id,
    plugin: chal.plugin,
    item: chal.item,
    app: chal.app,
    approver,
    approverIsOwner,
    signal: chal.signal,
  });
  return chal;
}

// Deny a challenge. Returns the challenge if found and pending, else null.
export function denyChallenge(id: string, approver: string, approverIsOwner: boolean): Challenge | null {
  const chal = challenges.get(id);
  if (!chal || chal.status !== "pending") return null;

  chal.status = "denied";
  audit("stepup.denied", {
    challengeId: id,
    plugin: chal.plugin,
    item: chal.item,
    app: chal.app,
    approver,
    approverIsOwner,
    signal: chal.signal,
  });
  return chal;
}

// Check if a token was the first use (for idempotency)
export function wasFirstUse(tokenStr: string, plugin: string): boolean {
  const tokenKey = `${plugin}-${tokenStr.slice(0, 16)}`;
  return !tokenFirstUse.has(tokenKey);
}
