// Twitter / X DEBUG actions — the same sealed vault jar, driven two ways:
//   - API path: the reverse-engineered client (agent-twitter-client), fed
//     auth_token + ct0 from the jar. Proven in Gen-1 (Python twitter-api-client).
//   - BROWSER path: drive the real logged-in browser (Browser SPI) and record the
//     FULL network trajectory (/capture-trace) — the ground truth we reify an
//     unofficial API from (RFC 0001). The lightweight bridge can RECORD but can't
//     ACTUATE a write (its /eval only reads innerText); actuating a post/like needs
//     the xdotool-instrumented browser. So browser-path writes throw, they don't
//     silently fall back to the API.
// Owner-only for now (server/handler.ts) — this is OAuth3's first WRITE surface.

import { requireNetworkLog } from "./browser.ts";
import { Jar } from "./plugins/types.ts";

// ---- API path (rettiwt-api) -----------------------------------------------
// agent-twitter-client pulls in a native WebRTC dep (@roamhq/wrtc) that crashes
// under Deno; rettiwt-api is pure-TS and cookie-based, so it's the in-TEE fit.
// Its apiKey is just the base64 of the site cookie string — twid carries the id.

async function rettiwtFromJar(jar: Jar) {
  const { Rettiwt } = await import("npm:rettiwt-api@7.1.2");
  if (!jar["auth_token"] || !jar["ct0"] || !jar["twid"]) {
    throw new Error("jar missing auth_token/ct0/twid — not logged in");
  }
  const cookieStr = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join(";");
  return new Rettiwt({ apiKey: btoa(cookieStr) });
}

export function apiMe(jar: Jar): unknown {
  // twid = "u=<userId>" (url-encoded); the authenticated id, no network call.
  return { userId: decodeURIComponent(jar["twid"] || "").replace(/^u=/, "") };
}

export async function apiTimeline(jar: Jar, count = 20): Promise<unknown[]> {
  const tl = await (await rettiwtFromJar(jar)).user.timeline(undefined, count);
  return (tl?.list ?? []).map((t: any) => ({ id: t.id, text: t.fullText, author: t.tweetBy?.userName }));
}

export async function apiTweet(jar: Jar, text: string): Promise<unknown> {
  if (!text) throw new Error("empty tweet text");
  return { op: "tweet", id: await (await rettiwtFromJar(jar)).tweet.post({ text }) };
}

export async function apiLike(jar: Jar, tweetId: string): Promise<unknown> {
  if (!tweetId) throw new Error("missing tweetId");
  return { op: "like", tweetId, ok: await (await rettiwtFromJar(jar)).tweet.like(tweetId) };
}

export async function apiUnlike(jar: Jar, tweetId: string): Promise<unknown> {
  if (!tweetId) throw new Error("missing tweetId");
  return { op: "unlike", tweetId, ok: await (await rettiwtFromJar(jar)).tweet.unlike(tweetId) };
}

// ---- Browser-path trace instrument (RFC 0001 reification) ------------------

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function jarToCookies(jar: Jar) {
  return Object.entries(jar).map(([name, value]) => ({
    name, value, domain: ".x.com", path: "/", secure: true, httpOnly: false, sameSite: "no_restriction",
  }));
}

async function bridge(spiUrl: string, path: string, body: unknown, secret: string): Promise<any> {
  const r = await fetch(`${spiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`browser SPI ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Which X GraphQL operation carried out which action — the map we reify against.
const OP_PATTERNS: Record<string, RegExp> = {
  tweet: /\/CreateTweet\b/,
  like: /\/FavoriteTweet\b/,
  unlike: /\/UnfavoriteTweet\b/,
  timeline: /\/HomeTimeline\b|\/HomeLatestTimeline\b/,
};

// Reduce a captured network_log to the X API calls of interest: the raw material for
// an unofficial API. Keeps the signing headers (esp x-client-transaction-id) that make
// server-side replay hard — that's the whole point of collecting real trajectories.
export function reifyTrace(networkLog: any[], action?: string): unknown[] {
  const pat = action ? OP_PATTERNS[action] : /\/i\/api\/graphql\//;
  return (networkLog || [])
    .filter((e) => pat.test(e.url || ""))
    .map((e) => ({
      op: (e.url || "").match(/\/graphql\/[^/]+\/([^/?]+)/)?.[1] ?? null,
      method: e.method,
      url: (e.url || "").split("?")[0],
      signing_headers: pick(e.request_headers || {}, [
        "authorization", "x-csrf-token", "x-client-transaction-id", "content-type",
        "x-twitter-active-user", "x-twitter-auth-type",
      ]),
      post_data: e.post_data ?? null,
      status: e.status ?? null,
      response_body: typeof e.response_body === "string" ? e.response_body.slice(0, 400) : null,
    }));
}

function pick(obj: Record<string, string>, keys: string[]): Record<string, string> {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase()] = v;
  const out: Record<string, string> = {};
  for (const k of keys) if (k in lower) out[k] = lower[k];
  return out;
}

// Inject the jar, navigate, let XHRs settle, capture the full trace, and reify.
// This is the READ instrument: it records whatever the page naturally requests
// (HomeTimeline etc.). Actuating a WRITE and tracing it needs the xdotool browser.
export async function browserTrace(
  spiUrl: string,
  jar: Jar,
  targetUrl: string,
  secret: string,
  action?: string,
): Promise<{ url: string; reified: unknown[]; ops: string[] }> {
  if (!spiUrl) throw new Error("BROWSER_SPI_URL not configured");
  await bridge(spiUrl, "/session", { cookies: jarToCookies(jar), userAgent: UA }, secret);
  await bridge(spiUrl, "/navigate", { url: targetUrl }, secret);
  await new Promise((r) => setTimeout(r, 5000));
  const t = await bridge(spiUrl, "/capture-trace", {}, secret);
  const log: any[] = requireNetworkLog(t) as any[];
  return {
    url: t.url || targetUrl,
    reified: reifyTrace(log, action),
    ops: [...new Set(log.map((e) => (e.url || "").match(/\/graphql\/[^/]+\/([^/?]+)/)?.[1]).filter(Boolean))],
  };
}
