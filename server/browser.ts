// Browser SPI client. For tasks where a rendered, logged-in view is the only option
// (no reifiable API), hand the SAME vault jar a plugin already holds to an external
// browser-in-TEE (login-with-anything/tee-browser) and get a screenshot back. The
// browser is just another consumer of the jar — it never logs in, never sees a
// password; the jar arrives sealed from the plugin/CLI sync like every other read.

import { Jar, Plugin } from "./plugins/types.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// The vault stores name->value only, so domain/secure are reconstructed from the
// plugin's cookieDomains. sameSite must be a chrome.cookies.set enum, not "None".
function jarToCookies(plugin: Plugin, jar: Jar) {
  const domain = plugin.cookieDomains[0];
  return Object.entries(jar).map(([name, value]) => ({
    name, value, domain, path: "/", secure: true, httpOnly: false, sameSite: "no_restriction",
  }));
}

// The browser bridge requires a shared secret on every control endpoint (it's reachable over
// the public gateway); we send it as a bearer on each call.
function authHeaders(secret: string): Record<string, string> {
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

async function spi(spiUrl: string, path: string, body: unknown, secret = ""): Promise<any> {
  const r = await fetch(`${spiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(secret) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`browser SPI ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// Reconstruct the logged-in home feed as structured items. The proof bridge's /eval
// returns the rendered page's innerText; we parse it into posts (skipping ads). Reads
// the browser SPI's current logged-in session — no jar injection, so it never clobbers it.
export interface FeedItem { name: string; handle: string; time: string; text: string; stats: string[]; }

function parseFeed(text: string): FeedItem[] {
  const m = text.match(/Your Home Timeline([\s\S]*?)(Subscribe to Premium|Today.s News|What.s happening|$)/);
  const lines = (m ? m[1] : text).split("\n").map((l) => l.trim()).filter((l) => l && l !== "͏ ͏ ͏");
  const isBoundary = (k: number) => k + 2 < lines.length && lines[k + 1].startsWith("@") && (lines[k + 2] === "·" || lines[k + 2] === "Ad");
  const items: FeedItem[] = [];
  let i = 0;
  while (i < lines.length - 2) {
    if (!isBoundary(i)) { i++; continue; }
    const isAd = lines[i + 2] === "Ad";
    const name = lines[i], handle = lines[i + 1];
    const time = lines[i + 2] === "·" ? (lines[i + 3] || "") : "";
    let j = i + (lines[i + 2] === "·" ? 4 : 3);
    const body: string[] = [];
    while (j < lines.length && !isBoundary(j)) { body.push(lines[j]); j++; }
    const stats: string[] = [];
    while (body.length && /^[\d,.]+[KM]?$/.test(body[body.length - 1])) stats.unshift(body.pop()!);
    const txt = body.filter((x) => x !== "Show more").join(" ").trim();
    if (!isAd && (txt || stats.length)) items.push({ name, handle, time, text: txt, stats });
    i = j;
  }
  return items;
}

export async function browserFeed(spiUrl: string, plugin: Plugin, jar: Jar, targetUrl: string, secret = ""): Promise<{ who: string; items: FeedItem[] }> {
  if (!spiUrl) throw new Error("BROWSER_SPI_URL not configured — no browser SPI to drive");
  await spi(spiUrl, "/session", { cookies: jarToCookies(plugin, jar), userAgent: UA }, secret); // inject the jar (like screenshot) — the SPI browser has no session otherwise
  await spi(spiUrl, "/navigate", { url: targetUrl }, secret);
  await new Promise((res) => setTimeout(res, 4000));
  // Whose session this is — the SPI's logged-in user, so the app can label the feed.
  const me = await fetch(`${spiUrl}/twitter/me`, { headers: authHeaders(secret) }).then((r) => r.json()).catch(() => ({}));
  const r = await spi(spiUrl, "/eval", { script: "x" }, secret); // proof bridge returns page innerText
  return { who: me.screen_name || "", items: parseFeed(r.text || "") };
}

export async function browserScreenshot(spiUrl: string, plugin: Plugin, jar: Jar, targetUrl: string, secret = "") {
  if (!spiUrl) throw new Error("BROWSER_SPI_URL not configured — no browser SPI to drive");
  await spi(spiUrl, "/session", { cookies: jarToCookies(plugin, jar), userAgent: UA }, secret);
  await spi(spiUrl, "/navigate", { url: targetUrl }, secret);
  await new Promise((res) => setTimeout(res, 5000)); // let logged-in XHR settle
  const cap = await spi(spiUrl, "/capture", {}, secret); // proof endpoint: url/title + saves artifact
  const png = await fetch(`${spiUrl}/screenshot`, { headers: authHeaders(secret), signal: AbortSignal.timeout(90_000) });
  if (!png.ok) throw new Error(`browser SPI /screenshot ${png.status}`);
  const b64 = toB64(new Uint8Array(await png.arrayBuffer()));
  return { screenshot: `data:image/png;base64,${b64}`, title: cap.certificate?.title };
}

// A 200 /capture-trace without a network_log is a broken capture, not an empty one — the
// response bodies ARE the payload (RFC 0001 M0), and an empty log reads downstream as "the
// site made no calls". Every consumer fails loud on it instead of laundering it into [].
export function requireNetworkLog(t: { network_log?: unknown }): unknown[] {
  if (!Array.isArray(t.network_log)) {
    throw new Error(
      `browser SPI /capture-trace returned no network_log: ${JSON.stringify(t).slice(0, 200)}`,
    );
  }
  return t.network_log;
}

// RFC 0001 M0: browser ground-truth capture with network_log for reification.
// Returns the full trace including network_log (XHR/Fetch requests with response bodies).
// The deployed bridge is auth-gated (BRIDGE_SECRET), so every control call carries the
// bearer — without it the SPI answers 401 before /capture-trace is even reached.
export async function browserCaptureTrace(
  spiUrl: string,
  plugin: Plugin,
  jar: Jar,
  targetUrl: string,
  secret = "",
) {
  if (!spiUrl) throw new Error("BROWSER_SPI_URL not configured — no browser SPI to drive");
  await spi(spiUrl, "/session", { cookies: jarToCookies(plugin, jar), userAgent: UA }, secret);
  await spi(spiUrl, "/navigate", { url: targetUrl }, secret);
  await new Promise((res) => setTimeout(res, 5000)); // let logged-in XHR settle
  const t = await spi(spiUrl, "/capture-trace", {}, secret);
  return {
    screenshot: t.screenshot,
    title: t.title,
    dom_html: t.dom_html,
    network_log: requireNetworkLog(t), // { requestId, method, url, request_headers, post_data, status, response_headers, response_body }
  };
}
