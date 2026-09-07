// NYTimes "Reading List" (saved articles). VERIFIED live 2026-06-24: the data comes
// from samizdat-graphql YourListQuery (a persisted query + the public project-vi
// nyt-token app header + the .nytimes.com cookie).
//
// IMPORTANT — NYT is a BROWSER-PATH site, not a frozen one. A server-side replay
// (deno/curl) with the EXACT cookie + token + headers is rejected by datadome
// bot-protection (HTTP 403); the identical request succeeds only from a real browser
// (TLS/JA3 + header fingerprint). So this adapter only works when the read runs in
// the browser path (Teleport Computer / browser SPI). On the frozen path it detects
// the 403 and throws a clear browser-path error rather than pretending. This is the
// canonical example of the ROADMAP's "needs a browser carrying the cookie" axis.

import { cookieHeader, Jar, Plugin, PluginItem, PluginListOptions } from "./types.ts";

const HASH = "baf36839d2052b17fce453a21ccf5bd8057d075730e848e9f0e61ec193daa5c5";
const NYT_TOKEN = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs+/oUCTBmD/cLdmcecrnBMHiU/pxQCn2DDyaPKUOXxi4p0uUSZQzsuq1pJ1m5z1i0YGPd1U1OeGHAChWtqoxC7bFMCXcwnE1oyui9G1uobgpm1GdhtwkR7ta7akVTcsF8zxiXx7DNXIPd2nIJFH83rmkZueKrC4JVaNzjvD+Z03piLn5bHWU6+w+rA+kyJtGgZNTXKyPh6EC6o5N+rknNMG5+CdTq35p8f99WjFawSvYgP9V64kgckbTbtdJ6YhVP58TnuYgr12urtwnIqWP9KSJ1e5vmgf3tunMqWNm6+AnsqNj8mCLdCuc5cEB74CwUeQcP2HQQmbCddBy2y0mEwIDAQAB"; // public project-vi app token, captured 2026-06-24 (may rotate)
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function listUrl(first: number): string {
  const variables = encodeURIComponent(JSON.stringify({ first }));
  const ext = encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: HASH } }));
  return `https://samizdat-graphql.nytimes.com/graphql/v2?operationName=YourListQuery&variables=${variables}&extensions=${ext}`;
}

async function readingList(jar: Jar, first: number): Promise<any[]> {
  const r = await fetch(listUrl(first), {
    headers: {
      "Cookie": cookieHeader(jar), "nyt-token": NYT_TOKEN, "nyt-app-type": "project-vi",
      "Origin": "https://www.nytimes.com", "Referer": "https://www.nytimes.com/saved",
      "Accept": "application/json", "User-Agent": UA,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (r.status === 403) {
    throw new Error("NYT blocks server-side replay (datadome 403) — nytimes is a BROWSER-PATH plugin; run it via the browser (Teleport Computer), not the frozen path");
  }
  if (r.status === 401) throw new Error("NYT rejected the jar — cookies expired");
  if (!r.ok) throw new Error(`nyt YourListQuery ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return j?.data?.user?.readingListAssetsConnection?.edges ?? [];
}

export const nytimesPlugin: Plugin = {
  id: "nytimes",
  label: "NYTimes saved (browser-path)",
  cookieDomains: [".nytimes.com"],
  // #12: server-side replay is datadome-403'd (see the header comment) — this instance is
  // cookie-only, so nytimes is honestly NOT available here. The marker makes /api/plugins
  // and the dashboard say so instead of reading as working.
  path: "browser",
  available: false,

  loggedIn(jar: Jar): boolean {
    return !!jar["NYT-S"];
  },

  async listItems(jar: Jar, _opts?: PluginListOptions): Promise<PluginItem[]> {
    const edges = await readingList(jar, 50);
    return edges.map((e: any): PluginItem => {
      const n = e?.node ?? {};
      return {
        id: String(n.url ?? n.id ?? e.cursor ?? ""),
        title: n.headline?.default ?? n.headline ?? n.promotionalHeadline ?? n.url ?? "",
        date: n.firstPublished ?? n.firstPublishedAt ?? undefined,
        meta: { url: n.url, summary: n.summary, kicker: n.kicker, type: n.__typename },
      };
    });
  },

  async fetchItem(jar: Jar, id: string): Promise<unknown> {
    const edges = await readingList(jar, 50);
    const hit = edges.find((e: any) => (e?.node?.url ?? e?.node?.id) === id);
    if (!hit) throw new Error(`nyt saved item ${id} not in reading list`);
    return hit.node;
  },
};
