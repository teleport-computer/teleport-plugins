// z.ai (GLM Coding Plan) plugin — delegated read of your usage dashboard
// (5-hour quota %, weekly quota % + reset, total tokens 7d, per-model breakdown,
// optional search/reader tool usage) through a scoped, revocable token. The app never
// sees the z.ai key; the pod holds the session bearer and does the authenticated read.
//
// Unlike the cookie-jar plugins, z.ai authenticates with a bearer token (the same
// `z-ai-open-platform-token-production` value the browser sends), synced into the jar
// under the key `zai_token` (see tasks/zai-token-grab.js + seed-zai-jar.sh). So there is
// no Cookie header — the jar carries one bearer and headers() sends it as Authorization.
//
// The single read surface is `quota()` (behind the `zai:usage-read` scope ingredient,
// readKind "quota"); this app does no item reads, so listItems/fetchItem throw.
//
// Upstream endpoints (response shapes verified against the live z.ai API 2026-07-16):
//   /api/monitor/usage/quota/limit  -> { code, msg, success, data:{ limits:[
//        { type:"TIME_LIMIT",  usage, currentValue, percentage, nextResetTime, usageDetails },  // search/reader
//        { type:"TOKENS_LIMIT", percentage, nextResetTime },   // resets soonest = 5-hour window
//        { type:"TOKENS_LIMIT", percentage, nextResetTime } ], level }}  // resets latest = weekly window
//   /api/monitor/usage/model-usage?startTime=&endTime=  (times as "yyyy-MM-dd HH:mm:ss") ->
//        data:{ totalUsage:{ totalTokensUsage, modelSummaryList:[{modelName,totalTokens,sortOrder}] }, ... }
// z.ai returns HTTP 200 even on failure; the real status is the {code,msg,success} envelope
// (getJSON below throws on success:false). Unknown/renamed fields throw a self-describing
// error (naming the missing field) rather than fabricating a value.

import { Jar, Plugin, PluginListOptions } from "./types.ts";

let BASE = "https://api.z.ai";
export function configureZai(env: Record<string, string>): void {
  if (env.ZAI_BASE) BASE = env.ZAI_BASE.replace(/\/$/, "");
}

const NO_ITEMS =
  "z.ai plugin is quota-only — read GET /api/zai/quota; it has no item list.";

function headers(jar: Jar): Record<string, string> {
  return { "Authorization": `Bearer ${jar["zai_token"]}`, "Accept": "application/json" };
}

async function getJSON(path: string, jar: Jar): Promise<unknown> {
  const r = await fetch(`${BASE}${path}`, { headers: headers(jar), signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`z.ai ${path} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  // z.ai returns HTTP 200 even on failure — the real status is in the {code,msg,success}
  // envelope, so status alone can't be trusted (verified: expired token → 200 + code 401).
  const b = body as Record<string, unknown>;
  if (b && typeof b === "object" && b.success === false) {
    const code = b.code, msg = String(b.msg ?? "unknown error");
    if (code === 401 || /token|auth/i.test(msg)) throw new Error(`z.ai rejected the token — ${msg} (re-sync the z.ai jar)`);
    throw new Error(`z.ai ${path}: ${msg} (code ${code})`);
  }
  return body;
}

// z.ai wraps successful bodies in { code, msg, data }. Unwrap to data, honestly.
function unwrap(body: unknown, path: string): Record<string, unknown> {
  const b = body as Record<string, unknown>;
  const d = b && typeof b === "object" && "data" in b ? b.data : b;
  if (!d || typeof d !== "object") throw new Error(`z.ai ${path}: no object body (got ${JSON.stringify(body).slice(0, 120)})`);
  return d as Record<string, unknown>;
}

function pick(obj: Record<string, unknown>, key: string, ctx: string): unknown {
  if (!(key in obj)) throw new Error(`z.ai ${ctx}: expected field "${key}", got keys [${Object.keys(obj).join(", ")}]`);
  return obj[key];
}
const num = (o: Record<string, unknown>, k: string, ctx: string): number => {
  const v = Number(pick(o, k, ctx));
  if (!Number.isFinite(v)) throw new Error(`z.ai ${ctx}: field "${k}" is not numeric (${JSON.stringify(o[k])})`);
  return v;
};

// model-usage wants "yyyy-MM-dd HH:mm:ss" (verified; UTC accepted), not epoch ms.
function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function toIso(v: unknown): string {
  if (typeof v === "number") return new Date(v).toISOString();
  const s = String(v);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`z.ai quota/limit: weekly reset "${s}" is not a parseable time`);
  return new Date(t).toISOString();
}

export const zaiPlugin: Plugin = {
  id: "zai",
  label: "z.ai GLM Coding Plan (usage)",
  cookieDomains: [".z.ai"], // jar is seeded with a bearer (zai_token), not scraped cookies
  renderUrl: "https://z.ai/manage-apikey/coding-plan/personal/usage",

  loggedIn(jar: Jar): boolean {
    return !!jar["zai_token"];
  },

  // deno-lint-ignore require-await
  async listItems(_jar: Jar, _opts?: PluginListOptions): Promise<never> {
    throw new Error(NO_ITEMS);
  },
  // deno-lint-ignore require-await
  async fetchItem(_jar: Jar, _id: string): Promise<never> {
    throw new Error(NO_ITEMS);
  },

  // The one read surface — composes two upstream reads into the app contract:
  //   { fiveHourPct, weeklyPct, weeklyResetIso, totalTokens7d, models:[{model,tokens}], searchReader? }
  // Shapes verified against the live z.ai API 2026-07-16 (see decodeQuotaLimit/model-usage below).
  async quota(jar: Jar): Promise<unknown> {
    // 1) quota/limit → a `limits[]` array. The two TOKENS_LIMIT entries are the 5-hour and
    //    weekly token windows (distinguished by reset time: 5h resets sooner); the TIME_LIMIT
    //    entry is the search/reader tool quota (currentValue used of `usage` limit).
    const ql = unwrap(await getJSON("/api/monitor/usage/quota/limit", jar), "quota/limit");
    const limits = ql.limits;
    if (!Array.isArray(limits)) throw new Error(`z.ai quota/limit: "limits" is not an array (keys [${Object.keys(ql).join(", ")}])`);
    const tokenLimits = (limits as Record<string, unknown>[])
      .filter((l) => l?.type === "TOKENS_LIMIT")
      .sort((a, b) => Number(a.nextResetTime) - Number(b.nextResetTime));
    if (tokenLimits.length < 2) throw new Error(`z.ai quota/limit: expected 2 TOKENS_LIMIT windows (5h + weekly), got ${tokenLimits.length}`);
    const fiveHour = tokenLimits[0]; // resets soonest = the 5-hour window
    const weekly = tokenLimits[tokenLimits.length - 1]; // resets latest = the weekly window
    const data: Record<string, unknown> = {
      fiveHourPct: num(fiveHour, "percentage", "quota/limit 5h window"),
      weeklyPct: num(weekly, "percentage", "quota/limit weekly window"),
      weeklyResetIso: toIso(pick(weekly, "nextResetTime", "quota/limit weekly window")),
    };
    const tool = (limits as Record<string, unknown>[]).find((l) => l?.type === "TIME_LIMIT");
    if (tool && "usage" in tool && "currentValue" in tool) {
      data.searchReader = { used: Number(tool.currentValue), limit: Number(tool.usage), unit: "requests" };
    }

    // 2) model-usage → total tokens (7d) + per-model totals. startTime/endTime want
    //    "yyyy-MM-dd HH:mm:ss" (UTC accepted). totalUsage carries both the grand total and
    //    the per-model summary.
    const now = Date.now();
    const qs = `startTime=${encodeURIComponent(fmtTime(now - 7 * 86_400_000))}&endTime=${encodeURIComponent(fmtTime(now))}`;
    const mu = unwrap(await getJSON(`/api/monitor/usage/model-usage?${qs}`, jar), "model-usage");
    const tot = (mu.totalUsage ?? mu) as Record<string, unknown>;
    data.totalTokens7d = num(tot, "totalTokensUsage", "model-usage.totalUsage");
    const summary = (mu.modelSummaryList ?? tot.modelSummaryList) as unknown;
    if (!Array.isArray(summary)) throw new Error(`z.ai model-usage: no modelSummaryList (keys [${Object.keys(mu).join(", ")}])`);
    data.models = (summary as Record<string, unknown>[])
      .slice()
      .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
      .map((m, i) => ({ model: String(pick(m, "modelName", `model-usage.modelSummaryList[${i}]`)), tokens: num(m, "totalTokens", `model-usage.modelSummaryList[${i}]`) }));
    return data;
  },
};
