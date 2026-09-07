import { assertEquals } from "jsr:@std/assert";
import {
  _resetForTest,
  approveChallenge,
  createChallenge,
  initStepup,
  score,
} from "./stepup.ts";
import { approveConnect, createConnect } from "./connect.ts";
import { listTokens, verify } from "./tokens.ts";

// Each test starts from a clean, in-memory consent ledger so first-use assertions are
// deterministic and independent of test ordering.
//
// Regression: an APPROVED challenge must let the token's next read through. Before the fix,
// approveChallenge left first-use set, so score() re-challenged forever.
Deno.test("stepup: approving a challenge clears first-use so the next read is approved", async () => {
  _resetForTest();
  const tok = "tok-amazon-deadbeefcafef00d";
  // first use → challenge
  assertEquals(score(tok, "amazon", "items").decision, "challenge");
  const chal = createChallenge("amazon", "items", tok, "cart-share", "first_token_use");
  // owner approves
  await approveChallenge(chal.challengeId, "owner", true);
  // next read now scores approve (not another challenge)
  assertEquals(score(tok, "amazon", "items").decision, "approve");
});

Deno.test("stepup: a denied/absent approval leaves the token challenging", () => {
  _resetForTest();
  const tok = "tok-amazon-11112222333344445555";
  assertEquals(score(tok, "amazon", "items").decision, "challenge");
  // no approval → still first use
  assertEquals(score(tok, "amazon", "items").decision, "challenge");
});

// oauth3-server#106 acceptance bullet 1: an approved token SURVIVES a core restart. The
// consent is persisted to the data volume and reloaded on boot, so a redeploy does not
// re-challenge a token the owner already approved (the biggest offender in the issue).
Deno.test("stepup: approved token survives a restart (persistence round-trip)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    _resetForTest();
    await initStepup(dir);
    const tok = "tok-reddit-aa11bb22cc33dd44ee55";
    const plugin = "reddit";

    // a genuinely-new, un-consented token trips exactly one challenge
    assertEquals(score(tok, plugin, "account").decision, "challenge");
    const chal = createChallenge(plugin, "account", tok, "karma-app", "first_token_use");
    await approveChallenge(chal.challengeId, "owner", true);
    // in-memory: now approved
    assertEquals(score(tok, plugin, "account").decision, "approve");

    // SIMULATE A CORE RESTART: wipe in-memory state, reload ONLY from the data volume.
    _resetForTest();
    await initStepup(dir);

    // ACCEPTANCE: still approved after restart — no re-challenge.
    assertEquals(score(tok, plugin, "account").decision, "approve");
  } finally {
    _resetForTest();
    await Deno.remove(dir, { recursive: true });
  }
});

// oauth3-server#106 acceptance bullet 2: a token minted through an owner-approved connect
// is pre-consented (the approve screen IS the out-of-band confirmation) and must never
// re-challenge on its first read. Runs fully in-memory to avoid polluting other suites'
// tokens/connect module state.
Deno.test("stepup: connect-approved token never re-challenges", async () => {
  _resetForTest();
  const r = await createConnect("reddit", undefined, "karma-app");
  const approved = await approveConnect(r.requestId, "u-owner");
  if (!approved || !approved.token) throw new Error("connect approval did not mint a token");

  // The freshly minted token reads WITHOUT a step-up challenge — owner already consented.
  assertEquals(score(approved.token, "reddit", "account").decision, "approve");

  // And a genuinely-new token (not from a connect) still trips exactly one challenge.
  const fresh = "tok-redriver-zzyyxxwwvvuu";
  assertEquals(score(fresh, "reddit", "account").decision, "challenge");
});

Deno.test("connect approval replaces the live grant for the same subject/plugin/app", async () => {
  const app = `dedup-${crypto.randomUUID()}`;
  const approved: string[] = [];
  for (let i = 0; i < 3; i++) {
    const request = await createConnect("reddit", undefined, app);
    const result = await approveConnect(request.requestId, "u-dedup");
    if (!result?.token) throw new Error("connect approval did not mint a token");
    approved.push(result.token);
  }

  assertEquals(approved.filter((token) => verify(token, "reddit") !== null), [approved[2]]);
  const trail = listTokens().filter((t) =>
    t.subject === "u-dedup" && t.plugin === "reddit" && t.app === app
  );
  assertEquals(trail.length, 3);
  assertEquals(trail.filter((t) => !t.revokedAt).map((t) => t.token), [approved[2]]);
  assertEquals(trail.filter((t) => t.revokedAt).length, 2);

  const otherApp = await createConnect("reddit", undefined, `${app}-other`);
  const other = await approveConnect(otherApp.requestId, "u-dedup");
  if (!other?.token) throw new Error("different app approval did not mint a token");
  assertEquals(verify(other.token, "reddit") !== null, true);
  assertEquals(verify(approved[2], "reddit") !== null, true);
});
