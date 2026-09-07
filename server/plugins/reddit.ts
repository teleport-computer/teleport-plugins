// Reddit plugin — delegated read of your saved posts/comments AND your account karma
// via Reddit's web .json API (cookie-authenticated, no OAuth app). Verified live
// 2026-06-24 against a real account:
//   /api/me.json                  -> { data: { name, comment_karma, link_karma, total_karma } }
//   /user/<name>/saved.json       -> { data: { children: [{ kind: t3|t1, data }] } }
//   /api/info.json?id=<fullname>  -> that item's full data (selftext / url / body)
// Reddit keys on a browser-like User-Agent; the whole .reddit.com jar is synced.
// The account read (/api/me.json) is the surface behind the `reddit:karma` scope
// ingredient — identity (username) + karma breakdown. (v1 lists the first page,
// limit=100; pagination via `after` is a TODO.)

import { cookieHeader, Jar, Plugin, PluginAccount, PluginItem, PluginListOptions, RedditListingItem, RedditListingResult } from "./types.ts";

// Live Reddit web API base. Override via REDDIT_BASE (e2e/mock) through
// configureReddit(); never read Deno.env at module top level (the isolated container
// runs --deny-env — env arrives via the handler's ctx.env, same pattern as otter).
let BASE = "https://www.reddit.com";
export function configureReddit(env: Record<string, string>): void {
  if (env.REDDIT_BASE) BASE = env.REDDIT_BASE.replace(/\/$/, "");
}
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function headers(jar: Jar): Record<string, string> {
  return { "Cookie": cookieHeader(jar), "User-Agent": UA };
}

async function getJSON(path: string, jar: Jar): Promise<any> {
  return (await getJSONWithHeaders(path, jar)).data;
}

async function getJSONWithHeaders(path: string, jar: Jar): Promise<{ data: any; rateLimitHeaders: Record<string, string> }> {
  const r = await fetch(`${BASE}${path}`, { headers: headers(jar), signal: AbortSignal.timeout(60_000) });
  if (r.status === 401 || r.status === 403) throw new Error("reddit rejected the jar — cookies expired");
  if (!r.ok) throw new Error(`reddit ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rateLimitHeaders: Record<string, string> = {};
  for (const name of ["x-ratelimit-used", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
    const value = r.headers.get(name);
    if (value !== null) rateLimitHeaders[name] = value;
  }
  return { data: await r.json(), rateLimitHeaders };
}

function listingItems(j: any): RedditListingItem[] {
  return (j?.data?.children ?? []).map((c: any) => {
    const d = c.data ?? {};
    return {
      id: String(d.id ?? d.name ?? ""), title: String(d.title ?? ""), score: Number(d.score) || 0,
      num_comments: Number(d.num_comments) || 0, created: Number(d.created_utc) || 0,
      permalink: String(d.permalink ?? ""), url: String(d.url ?? ""), author: String(d.author ?? ""),
      ...(d.subreddit ? { subreddit: String(d.subreddit) } : {}),
    };
  });
}

async function listing(path: string, jar: Jar): Promise<RedditListingResult> {
  const result = await getJSONWithHeaders(path, jar);
  return { items: listingItems(result.data), rateLimitHeaders: result.rateLimitHeaders };
}

// /api/me.json → the logged-in account's data (name + karma). The single call behind
// both username resolution (for saved-posts) and the account/karma read.
async function me(jar: Jar): Promise<any> {
  const j = await getJSON("/api/me.json", jar);
  const d = j?.data;
  if (!d) throw new Error("could not resolve reddit account from /api/me.json");
  return d;
}

async function username(jar: Jar): Promise<string> {
  const name = (await me(jar)).name;
  if (!name) throw new Error("could not resolve reddit username from /api/me.json");
  return String(name);
}

export const redditPlugin: Plugin = {
  id: "reddit",
  label: "Reddit (saved + karma)",
  cookieDomains: [".reddit.com"],
  renderUrl: "https://www.reddit.com",

  loggedIn(jar: Jar): boolean {
    return !!jar["reddit_session"];
  },

  async listItems(jar: Jar, _opts?: PluginListOptions): Promise<PluginItem[]> {
    const name = await username(jar);
    const j = await getJSON(`/user/${encodeURIComponent(name)}/saved.json?limit=100&raw_json=1`, jar);
    return (j?.data?.children ?? []).map((c: any): PluginItem => {
      const d = c.data ?? {};
      const isComment = c.kind === "t1";
      return {
        id: String(d.name), // reddit fullname, e.g. t3_abc123
        title: isComment ? `comment on "${(d.link_title || "").slice(0, 60)}"` : (d.title || ""),
        date: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : undefined,
        meta: { kind: c.kind, subreddit: d.subreddit, author: d.author, permalink: d.permalink, url: d.url },
      };
    });
  },

  async fetchItem(jar: Jar, id: string): Promise<unknown> {
    const j = await getJSON(`/api/info.json?id=${encodeURIComponent(id)}&raw_json=1`, jar);
    const c = j?.data?.children?.[0];
    if (!c) throw new Error(`reddit item ${id} not found`);
    const d = c.data ?? {};
    return {
      id, kind: c.kind, title: d.title, subreddit: d.subreddit, author: d.author,
      permalink: d.permalink, url: d.url, score: d.score, body: d.selftext || d.body || "",
    };
  },

  // Account-level read (the surface behind the `reddit:karma` scope ingredient):
  // the logged-in account's identity + karma breakdown. `total_karma` is taken from
  // Reddit when present, else derived as comment + link (the web .json shape omits it
  // for some accounts). Gated at the handler read chokepoint (readKind "account").
  async account(jar: Jar): Promise<PluginAccount> {
    const d = await me(jar);
    const name = d.name ? String(d.name) : "";
    if (!name) throw new Error("could not resolve reddit account from /api/me.json");
    const comment = Number(d.comment_karma) || 0;
    const link = Number(d.link_karma) || 0;
    const total = Number(d.total_karma) || comment + link;
    return {
      id: name,
      label: `u/${name}`,
      fields: [
        { key: "total_karma", label: "Total karma", value: total },
        { key: "comment_karma", label: "Comment karma", value: comment },
        { key: "link_karma", label: "Link karma", value: link },
      ],
    };
  },

  async subreddit(jar: Jar, name: string, sort: string, limit: number, t?: string): Promise<RedditListingResult> {
    const qs = new URLSearchParams({ sort, limit: String(limit), raw_json: "1" });
    if (t) qs.set("t", t);
    return listing(`/r/${encodeURIComponent(name)}/${encodeURIComponent(sort)}.json?${qs}`, jar);
  },

  async search(jar: Jar, query: string, subreddit: string | undefined, sort: string, limit: number): Promise<RedditListingResult> {
    const qs = new URLSearchParams({ q: query, sort, limit: String(limit), raw_json: "1" });
    // restrict_sr only means anything on /r/<sub>/search — root /search has no subreddit
    // param, so posting it there would silently return site-wide results.
    if (subreddit) {
      qs.set("restrict_sr", "1");
      return listing(`/r/${encodeURIComponent(subreddit)}/search.json?${qs}`, jar);
    }
    return listing(`/search.json?${qs}`, jar);
  },
};
