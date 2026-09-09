// Tests for the reddit plugin's account/karma read + the GET /api/:plugin/account route
// + the `reddit:karma` scope ingredient. No live Reddit dependency: a local mock serves
// /api/me.json (and /user/<n>/saved.json for the saved-posts regression) and REDDIT_BASE
// points the plugin at it via configureReddit() — the same override seam otter uses.

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import { configureReddit, redditPlugin } from "./reddit.ts";
import handler from "../handler.ts";
import { mint } from "../tokens.ts";
import { recordTokenUse } from "../stepup.ts";

const OWNER = "test-owner-secret";

// A realistic /api/me.json payload (the web shape Reddit returns for a logged-in user).
const ME = {
  kind: "t2",
  data: {
    name: "karma_tester",
    comment_karma: 1234,
    link_karma: 567,
    total_karma: 1801,
    created_utc: 1577836800,
  },
};
const SAVED = {
  data: {
    children: [
      {
        kind: "t3",
        data: {
          name: "t3_abc",
          title: "a saved post",
          subreddit: "test",
          created_utc: 1700000000,
          url: "https://example.com/x",
          permalink: "/r/test/x",
        },
      },
    ],
  },
};

// A listed post as a subreddit/search listing child. Root /search.json serves it WITHOUT
// rate-limit headers (the pass-through must not fabricate them); /r/test/search.json serves a
// marker variant ONLY when restrict_sr=1 is on the wire — root /search has no subreddit param,
// so a sub-restricted search must prove it took the /r/<sub>/search path.
const LISTED = {
  id: "abc", title: "a listed post", score: 42, num_comments: 7, created_utc: 1700000000,
  permalink: "/r/test/abc", url: "https://example.com/abc", author: "poster", subreddit: "test",
};

function mockReddit(req: Request): Response {
  const u = new URL(req.url);
  if (u.pathname === "/api/me.json") return Response.json(ME);
  if (u.pathname === "/r/test/hot.json") {
    return new Response(JSON.stringify({ data: { children: [{ kind: "t3", data: LISTED }] } }), {
      headers: { "Content-Type": "application/json", "x-ratelimit-used": "3", "x-ratelimit-remaining": "97" },
    });
  }
  if (u.pathname === "/search.json") {
    return new Response(JSON.stringify({ data: { children: [{ kind: "t3", data: LISTED }] } }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (u.pathname === "/r/test/search.json") {
    const children = u.searchParams.get("restrict_sr") === "1"
      ? [{ kind: "t3", data: { ...LISTED, id: "subq", title: "a sub-restricted hit" } }]
      : [];
    return new Response(JSON.stringify({ data: { children } }), {
      headers: { "Content-Type": "application/json", "x-ratelimit-used": "4", "x-ratelimit-remaining": "96" },
    });
  }
  if (u.pathname.startsWith("/user/") && u.pathname.endsWith("/saved.json")) {
    return Response.json(SAVED);
  }
  if (u.pathname.startsWith("/api/info.json")) {
    return Response.json({
      data: { children: [{ kind: "t3", data: SAVED.data.children[0].data }] },
    });
  }
  return new Response("not found", { status: 404 });
}

let base = "";
let server: { shutdown(): Promise<void> } | undefined;

Deno.test("reddit karma: start mock server", async () => {
  const ready = Promise.withResolvers<string>();
  server = Deno.serve(
    {
      port: 0,
      hostname: "127.0.0.1",
      onListen: (a) => ready.resolve(`http://${a.hostname}:${a.port}`),
    },
    mockReddit,
  );
  base = await ready.promise;
  configureReddit({ REDDIT_BASE: base });
});

// --- plugin unit tests ---

Deno.test("reddit karma: loggedIn keys on reddit_session", () => {
  assertEquals(redditPlugin.loggedIn({ reddit_session: "x" }), true);
  assertEquals(redditPlugin.loggedIn({ other: "y" }), false);
});

Deno.test("reddit karma: account() returns identity + karma breakdown", async () => {
  const a = await redditPlugin.account!({ reddit_session: "x" });
  assertEquals(a.id, "karma_tester");
  assertEquals(a.label, "u/karma_tester");
  assertEquals(a.fields.map((f) => f.key), ["total_karma", "comment_karma", "link_karma"]);
  assertEquals(a.fields.find((f) => f.key === "comment_karma")!.value, 1234);
  assertEquals(a.fields.find((f) => f.key === "link_karma")!.value, 567);
  assertEquals(a.fields.find((f) => f.key === "total_karma")!.value, 1801);
});

Deno.test("reddit karma: total_karma derived when Reddit omits it", async () => {
  // Some accounts' web .json omits total_karma; it must fall back to comment + link.
  const me = await redditPlugin.account!({ reddit_session: "x" });
  const derived = me.fields.find((f) => f.key === "comment_karma")!.value as number +
    (me.fields.find((f) => f.key === "link_karma")!.value as number);
  assertEquals(me.fields.find((f) => f.key === "total_karma")!.value, derived);
});

Deno.test("reddit karma: saved-posts listItems still works (regression)", async () => {
  const items = await redditPlugin.listItems({ reddit_session: "x" });
  assertEquals(items.length, 1);
  assertEquals(items[0].id, "t3_abc");
  assertEquals(items[0].title, "a saved post");
});

Deno.test("reddit read: listing and search preserve item shape and rate limits", async () => {
  const listing = await redditPlugin.subreddit!({ reddit_session: "x" }, "test", "hot", 25);
  assertEquals(listing.items[0], {
    id: "abc", title: "a listed post", score: 42, num_comments: 7, created: 1700000000,
    permalink: "/r/test/abc", url: "https://example.com/abc", author: "poster", subreddit: "test",
  });
  assertEquals(listing.rateLimitHeaders, { "x-ratelimit-used": "3", "x-ratelimit-remaining": "97" });
  const search = await redditPlugin.search!({ reddit_session: "x" }, "term", undefined, "relevance", 10);
  assertEquals(search.items.length, 1);
  assertEquals(search.rateLimitHeaders, {}); // absent upstream ⇒ absent downstream, never fabricated
});

Deno.test("reddit read: search with sub takes /r/<sub>/search.json and sends restrict_sr", async () => {
  const subbed = await redditPlugin.search!({ reddit_session: "x" }, "term", "test", "relevance", 10);
  assertEquals(subbed.items[0].id, "subq"); // marker served only on the sub path with restrict_sr=1
  assertEquals(subbed.rateLimitHeaders, { "x-ratelimit-used": "4", "x-ratelimit-remaining": "96" });
});

// --- handler / route tests (in-process; in-memory vault via dataDir: "") ---

function ctx() {
  return { env: { OWNER_SECRET: OWNER, REDDIT_BASE: base }, dataDir: "" };
}

async function call(
  method: string,
  path: string,
  opts: { bearer?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return await handler(
    new Request(`http://oauth3.test${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    ctx(),
  );
}

Deno.test("reddit karma: route returns karma for owner", async () => {
  await call("GET", "/api/health"); // bootstrap init (sets OWNER_SECRET + REDDIT_BASE)
  await call("POST", "/api/cookies", {
    bearer: OWNER,
    body: { plugin: "reddit", cookies: { reddit_session: "sess" } },
  });
  const r = await call("GET", "/api/reddit/account", { bearer: OWNER });
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals(j.plugin, "reddit");
  assertEquals(j.account.id, "karma_tester");
  assertEquals(j.account.fields.find((f: { key: string }) => f.key === "total_karma").value, 1801);
});

Deno.test("reddit karma: route 401 without auth", async () => {
  const r = await call("GET", "/api/reddit/account");
  assertEquals(r.status, 401);
});

Deno.test("reddit karma: 404 for a plugin with no account view", async () => {
  const r = await call("GET", "/api/otter/account", { bearer: OWNER });
  assertEquals(r.status, 404);
});

Deno.test("reddit karma: scope-confined token is denied account", async () => {
  // A reddit token confined to otter:live-follow reads (live+frame) may NOT read account.
  const t = await mint("reddit", "owner", "deny-demo", ["otter:live-follow"]);
  const r = await call("GET", "/api/reddit/account", { bearer: t.token });
  assertEquals(r.status, 403);
  const j = await r.json();
  assert(typeof j.scope === "string");
});

Deno.test("reddit karma: reddit:karma-scoped token reads account", async () => {
  const t = await mint("reddit", "owner", "karma-demo", ["reddit:karma"]);
  recordTokenUse(t.token, "reddit"); // clear first-use step-up so the read is deterministic
  const r = await call("GET", "/api/reddit/account", { bearer: t.token });
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals(j.account.id, "karma_tester");
  assertEquals(
    j.account.fields.find((f: { key: string }) => f.key === "comment_karma").value,
    1234,
  );
});

Deno.test("reddit karma: reddit:karma-scoped token CANNOT read saved posts", async () => {
  // The narrow attenuation: account-only, not /items.
  const t = await mint("reddit", "owner", "karma-only", ["reddit:karma"]);
  recordTokenUse(t.token, "reddit");
  const r = await call("GET", "/api/reddit/items", { bearer: t.token });
  assertEquals(r.status, 403);
});

Deno.test("reddit read: reddit:read permits listings but not account/items", async () => {
  const t = await mint("reddit", "owner", "read-demo", ["reddit:read"]);
  recordTokenUse(t.token, "reddit");
  assertEquals((await call("GET", "/api/reddit/sub/test?sort=hot&limit=25", { bearer: t.token })).status, 200);
  const root = await call("GET", "/api/reddit/search?q=term", { bearer: t.token });
  assertEquals(root.status, 200);
  assertEquals(root.headers.get("x-ratelimit-used"), null); // root mock sends none — none fabricated
  const subbed = await call("GET", "/api/reddit/search?q=term&sub=test", { bearer: t.token });
  assertEquals(subbed.status, 200);
  assertEquals((await subbed.json()).items[0].id, "subq");
  assertEquals(subbed.headers.get("x-ratelimit-used"), "4"); // verbatim pass-through on the wire
  assertEquals((await call("GET", "/api/reddit/account", { bearer: t.token })).status, 403);
  assertEquals((await call("GET", "/api/reddit/items", { bearer: t.token })).status, 403);
});

Deno.test("reddit read: reddit:karma cannot read listings", async () => {
  const t = await mint("reddit", "owner", "karma-no-list", ["reddit:karma"]);
  recordTokenUse(t.token, "reddit");
  assertEquals((await call("GET", "/api/reddit/sub/test", { bearer: t.token })).status, 403);
  assertEquals((await call("GET", "/api/reddit/search?q=term", { bearer: t.token })).status, 403);
});

Deno.test("reddit karma: /api/plugins advertises account support", async () => {
  const r = await call("GET", "/api/plugins", { bearer: OWNER });
  assertEquals(r.status, 200);
  const j = await r.json();
  const reddit = j.plugins.find((p: { id: string }) => p.id === "reddit");
  const otter = j.plugins.find((p: { id: string }) => p.id === "otter");
  assertEquals(reddit.account, true);
  assertEquals(otter.account, false);
});

Deno.test("reddit karma: /api/scopes lists reddit:karma ingredient", async () => {
  const r = await call("GET", "/api/scopes");
  assertEquals(r.status, 200);
  const j = await r.json();
  const ids: string[] = j.scopes.map((s: { id: string }) => s.id);
  assertNotEquals(ids.indexOf("reddit:karma"), -1);
  assertNotEquals(ids.indexOf("reddit:read"), -1);
});

Deno.test("reddit karma: stop mock server", async () => {
  await server?.shutdown();
});
