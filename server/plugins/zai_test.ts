// Tests for the zai plugin's quota read + the GET /api/:plugin/quota route + the
// `zai:usage-read` scope ingredient. No live z.ai dependency: a local mock serves the
// three monitor endpoints and ZAI_BASE points the plugin at it via configureZai().
//
// The mock encodes the REAL z.ai response shapes (verified against the live API 2026-07-16):
// quota/limit returns a limits[] array (2 TOKENS_LIMIT windows + 1 TIME_LIMIT tool quota),
// model-usage returns data.totalUsage{totalTokensUsage, modelSummaryList}. These tests prove
// the route, the scope gate, and the upstream→contract composition.

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import { configureZai, zaiPlugin } from "./zai.ts";
import handler from "../handler.ts";
import { mint } from "../tokens.ts";
import { recordTokenUse } from "../stepup.ts";

const OWNER = "test-owner-secret";
const JAR = { zai_token: "ey.fake.bearer" };

// Real z.ai response shapes. Reset times: 5h resets soonest, weekly latest, tool furthest.
const SOON = 1784225948649, WEEK = 1784803512998, FAR = 1785667512995;
const LIMIT = { code: 200, msg: "Operation successful", success: true, data: { limits: [
  { type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 0, remaining: 4000, percentage: 0, nextResetTime: FAR, usageDetails: [{ modelCode: "search-prime", usage: 0 }] },
  { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 3, nextResetTime: SOON },
  { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 32, nextResetTime: WEEK },
], level: "max" } };
const MODEL_USAGE = { code: 200, msg: "Operation successful", success: true, data: {
  x_time: ["2026-07-09 13:00"], granularity: "hourly",
  totalUsage: { totalModelCallCount: 5866, totalTokensUsage: 291_000_000, modelSummaryList: [
    { modelName: "GLM-5.2", totalTokens: 250_000_000, sortOrder: 1 },
    { modelName: "GLM-4.7", totalTokens: 41_000_000, sortOrder: 2 },
  ] },
} };
// z.ai returns HTTP 200 even on auth failure (envelope carries the real status).
const AUTH_FAIL = { code: 401, msg: "token expired or incorrect", success: false };

function mockZai(req: Request): Response {
  const u = new URL(req.url);
  const tok = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
  if (!tok) return new Response("unauthorized", { status: 401 });
  if (tok === "expired") return Response.json(AUTH_FAIL); // 200 + success:false
  if (u.pathname === "/api/monitor/usage/quota/limit") return Response.json(LIMIT);
  if (u.pathname === "/api/monitor/usage/model-usage") return Response.json(MODEL_USAGE);
  return new Response("not found", { status: 404 });
}

let base = "";
let server: { shutdown(): Promise<void> } | undefined;

Deno.test("zai usage: start mock server", async () => {
  const ready = Promise.withResolvers<string>();
  server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: (a) => ready.resolve(`http://${a.hostname}:${a.port}`) }, mockZai);
  base = await ready.promise;
  configureZai({ ZAI_BASE: base });
});

// --- plugin unit tests ---

Deno.test("zai usage: loggedIn keys on zai_token", () => {
  assertEquals(zaiPlugin.loggedIn({ zai_token: "x" }), true);
  assertEquals(zaiPlugin.loggedIn({ other: "y" }), false);
});

Deno.test("zai usage: quota() composes the app contract shape", async () => {
  const d = await zaiPlugin.quota!(JAR) as Record<string, unknown>;
  assertEquals(d.fiveHourPct, 3); // TOKENS_LIMIT resetting soonest
  assertEquals(d.weeklyPct, 32); // TOKENS_LIMIT resetting latest
  assertEquals(d.weeklyResetIso, new Date(WEEK).toISOString());
  assertEquals(d.totalTokens7d, 291_000_000);
  assertEquals((d.models as unknown[]).length, 2);
  assertEquals((d.models as { model: string; tokens: number }[])[0], { model: "GLM-5.2", tokens: 250_000_000 });
  assertEquals(d.searchReader, { used: 0, limit: 4000, unit: "requests" });
});

Deno.test("zai usage: HTTP-200-with-success:false surfaces as an honest error (not fake data)", async () => {
  await zaiPlugin.quota!({ zai_token: "expired" }).then(
    () => { throw new Error("should have thrown on token expired"); },
    (e) => assert(/token expired|rejected the token/i.test((e as Error).message)),
  );
});

Deno.test("zai usage: listItems/fetchItem throw (quota-only plugin)", async () => {
  await zaiPlugin.listItems(JAR).then(() => { throw new Error("should have thrown"); }, () => {});
  await zaiPlugin.fetchItem(JAR, "x").then(() => { throw new Error("should have thrown"); }, () => {});
});

// --- handler / route tests (in-process; in-memory vault via dataDir: "") ---

function ctx() {
  return { env: { OWNER_SECRET: OWNER, ZAI_BASE: base }, dataDir: "" };
}
async function call(method: string, path: string, opts: { bearer?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return await handler(new Request(`http://oauth3.test${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }), ctx());
}

Deno.test("zai usage: route returns quota for owner", async () => {
  await call("GET", "/api/health"); // bootstrap init (sets OWNER_SECRET + ZAI_BASE)
  await call("POST", "/api/cookies", { bearer: OWNER, body: { plugin: "zai", cookies: JAR } });
  const r = await call("GET", "/api/zai/quota", { bearer: OWNER });
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals(j.plugin, "zai");
  assertEquals(j.data.weeklyPct, 32);
  assertEquals(j.data.totalTokens7d, 291_000_000);
});

Deno.test("zai usage: route 401 without auth", async () => {
  const r = await call("GET", "/api/zai/quota");
  assertEquals(r.status, 401);
});

Deno.test("zai usage: 404 for a plugin with no quota view", async () => {
  const r = await call("GET", "/api/reddit/quota", { bearer: OWNER });
  assertEquals(r.status, 404);
});

Deno.test("zai usage: scope-confined token is denied quota", async () => {
  // A zai token confined to an unrelated ingredient (otter:live-follow → live+frame) may
  // NOT read quota — the gate denies before any upstream call.
  const t = await mint("zai", "owner", "deny-demo", ["otter:live-follow"]);
  const r = await call("GET", "/api/zai/quota", { bearer: t.token });
  assertEquals(r.status, 403);
  assert(typeof (await r.json()).scope === "string");
});

Deno.test("zai usage: zai:usage-read-scoped token reads quota", async () => {
  const t = await mint("zai", "owner", "usage-demo", ["zai:usage-read"]);
  recordTokenUse(t.token, "zai"); // clear first-use step-up so the read is deterministic
  const r = await call("GET", "/api/zai/quota", { bearer: t.token });
  assertEquals(r.status, 200);
  assertEquals((await r.json()).data.fiveHourPct, 3);
});

Deno.test("zai usage: /api/scopes lists zai:usage-read ingredient", async () => {
  const r = await call("GET", "/api/scopes");
  assertEquals(r.status, 200);
  const ids: string[] = (await r.json()).scopes.map((s: { id: string }) => s.id);
  assertNotEquals(ids.indexOf("zai:usage-read"), -1);
});

Deno.test("zai usage: stop mock server", async () => {
  await server?.shutdown();
});
