// ChatGPT/Codex subscription usage via the official Codex backend usage endpoint.
import { Jar, Plugin, PluginListOptions } from "./types.ts";

let BASE = "https://chatgpt.com";
export function configureCodex(env: Record<string, string>): void {
  if (env.CODEX_BASE) BASE = env.CODEX_BASE.replace(/\/$/, "");
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`codex usage: missing object "${name}"`);
  }
  return value as Record<string, unknown>;
}
function number(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`codex usage: field "${name}" is not numeric`);
  return n;
}
function iso(value: unknown, name: string): string {
  const n = number(value, name);
  const date = new Date(n < 10_000_000_000 ? n * 1000 : n);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`codex usage: field "${name}" is not a valid timestamp`);
  }
  return date.toISOString();
}

export function parseCodexUsage(body: unknown): Record<string, unknown> {
  const root = object(body, "response");
  const limits = object(root.rate_limits, "rate_limits");
  const primary = object(limits.primary, "rate_limits.primary");
  const secondary = object(limits.secondary, "rate_limits.secondary");
  return {
    fiveHourPct: number(primary.used_percent, "rate_limits.primary.used_percent"),
    fiveHourResetIso: iso(primary.resets_at, "rate_limits.primary.resets_at"),
    weeklyPct: number(secondary.used_percent, "rate_limits.secondary.used_percent"),
    weeklyResetIso: iso(secondary.resets_at, "rate_limits.secondary.resets_at"),
    planType: limits.plan_type === undefined || limits.plan_type === null
      ? null
      : String(limits.plan_type),
  };
}

async function getUsage(jar: Jar): Promise<unknown> {
  if (!jar.codex_token) {
    throw new Error("codex usage: no bearer token synced — reconnect ChatGPT/Codex");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jar.codex_token}`,
    Accept: "application/json",
    "OAI-Product-Sku": "CODEX",
  };
  if (jar.codex_account_id) headers["ChatGPT-Account-Id"] = jar.codex_account_id;
  const response = await fetch(`${BASE}/backend-api/wham/usage`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("codex rejected the bearer — reconnect ChatGPT/Codex");
    }
    throw new Error(
      `codex usage HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  return parseCodexUsage(await response.json());
}

const NO_ITEMS = "codex plugin is quota-only — read GET /api/codex/quota; it has no item list.";
export const codexPlugin: Plugin = {
  id: "codex",
  label: "ChatGPT/Codex (usage)",
  cookieDomains: [".chatgpt.com"],
  tokenSource: {
    origin: "https://chatgpt.com",
    localStorage: ["codex_access_token", "access_token"],
    jarKey: "codex_token",
  },
  renderUrl: "https://chatgpt.com/codex/settings/usage",
  loggedIn: (jar) => !!jar.codex_token,
  // deno-lint-ignore require-await
  async listItems(_jar: Jar, _opts?: PluginListOptions): Promise<never> {
    throw new Error(NO_ITEMS);
  },
  // deno-lint-ignore require-await
  async fetchItem(_jar: Jar, _id: string): Promise<never> {
    throw new Error(NO_ITEMS);
  },
  async quota(jar: Jar): Promise<unknown> {
    return getUsage(jar);
  },
};
