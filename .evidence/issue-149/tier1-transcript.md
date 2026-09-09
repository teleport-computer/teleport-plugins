# Tier 1 evidence — issue #149 (reddit subreddit listing + search read, `reddit:read`)

**Deployed commit:** `c9e6359` (branch `staging-oa-149`, code commit; this evidence file follows it)
**Deployed shape:** real tee-daemon (rootless docker, container-isolated deno project `oauth3`,
flat tarball `entry=handler.ts`, `listen.port=8080` path routing) — the same deploy recipe
`deploy.sh` pins, run on a local daemon because **no staging daemon token exists on this box**
(`~/.tee-daemon-staging.env` is operator-only by the uid split; searched 2026-08-29 and again
today). Precedent: PR #185's accepted local-daemon Tier-1 transcript.
**Honest limit of this transcript:** zed's IP is 403-blocked by www.reddit.com for anonymous
`.json` (verified 2026-09-07: `GET /r/test/hot.json` → 403 from this box), and no Reddit
credentials or jar snapshot exist here — so the "fresh reddit jar ⇒ real posts" acceptance leg
is NOT demonstrated below and is operator-run (exact commands at the bottom). Everything else —
scope registration, capability statement on the approve page, the app connect/approve/token
handshake, both cross-denials, jar-less and logged-out-jar errors, and the version pin — ran
live over HTTP against the deployed commit below.

## Version pin

```
$ curl http://localhost:18080/oauth3/_api/version
{"service":"oauth3-server","commit":"c9e6359"}        # == branch HEAD c9e6359
```

## Scope ingredient (`GET /api/scopes`)

```
{
  "id": "reddit:read",
  "plugin": "reddit",
  "reads": ["sub", "search"],
  "label": "read-only · subreddit listings and search fetched as your Reddit session · not your account, saved posts, feed, votes, or messages"
}
```
The label names the session-attribution trade-off ("fetched as your Reddit session") exactly as
the acceptance requires.

## Capability statement on the live approve page

`POST /api/connect {"plugin":"reddit","app":"demo-app","caps":["reddit:read"]}` →
`requestId=req-49f7e3a1d1d7…`; `GET /approve/<id>` renders:

> CAN read your saved posts and comments (and each item's full body/url), **subreddit listings
> and search results**, your account identity and karma (comment + link), and a logged-in
> screenshot of reddit.com. CANNOT save, vote, post, comment, or edit.

CAN clause amended; CANNOT clause unchanged.

## The app handshake (no owner-minted tokens)

```
$ POST /api/login {"userKey":"<64hex>"}   → {"ok":true,"subject":"u-5f9717e3692ef806fdd1a71dcf483589","session":"sess-cb013…"}
$ POST /api/connect {"plugin":"reddit","app":"demo-app","subject":"u-5f9717…","caps":["reddit:read"]}
  → {"requestId":"req-49f7e3a1d1d7427299a2b81a8a7113d7","approveUrl":"…/approve/req-49f7e3a1…"}
$ POST /api/connect/req-49f7e3a1…/approve {"owner_secret":"…"} → {"ok":true,"status":"approved"}
$ GET  /api/connect/req-49f7e3a1… → {"status":"approved","token":"tok-reddit-4cc61ad25d8b43428aa5cfb5"}
```

## Reads with the reddit:read token — jar-less subject

```
$ GET /api/reddit/sub/LocalLLaMA?sort=hot&limit=25   (Bearer tok-reddit-4cc61ad2…)
{"error":"no jar synced for reddit"}                                    HTTP 409
$ GET /api/reddit/search?q=llm&limit=10
{"error":"no jar synced for reddit"}                                    HTTP 409
```

## Jar present but logged out (rotted/partial jar)

```
$ POST /api/cookies {"plugin":"reddit","cookies":{"theme":"dark"}}  (owner) → 200
$ GET /api/reddit/sub/LocalLLaMA?sort=hot&limit=25   (Bearer tok-reddit-4cc61ad2…)
{"error":"not logged in to reddit"}                                     HTTP 409
$ GET /api/reddit/search?q=llm
{"error":"not logged in to reddit"}                                     HTTP 409
```
Both error states are explicit and distinct; neither can be mistaken for an empty listing.

## Confinement, both ways (deployed gateRead)

```
reddit:read token → GET /api/reddit/account
{"error":"scope: this token may read sub+search only, not account","scope":"read-only · subreddit listings and search fetched as your Reddit session · …"}  HTTP 403
reddit:read token → GET /api/reddit/items
{"error":"scope: this token may read sub+search only, not items", …}   HTTP 403

reddit:karma token (second connect, caps ["reddit:karma"]) → GET /api/reddit/sub/test?sort=hot
{"error":"scope: this token may read account only, not sub", …}        HTTP 403
reddit:karma token → GET /api/reddit/search?q=x
{"error":"scope: this token may read account only, not search", …}     HTTP 403
reddit:karma token → GET /api/reddit/account   (passes the scope gate; fails only on the jar)
{"error":"no jar synced for reddit"}                                   HTTP 409
```

## Anonymous

```
$ GET /api/reddit/sub/test      (no auth)
{"error":"unauthorized"}                                               HTTP 401
```

## Wire-contract coverage that needs no live reddit (mock-backed, `deno task test`)

`server/plugins/reddit_test.ts` (147 passed | 0 failed at `c9e6359`):
- listing + search item shape (id, title, score, num_comments, created, permalink, url, author,
  subreddit) and `x-ratelimit-used/remaining` captured verbatim from upstream;
- headers absent upstream ⇒ absent downstream (root `/search.json` mock serves none; asserted
  `{}` at the plugin and `null` on the wire);
- **sub-restricted search takes `/r/<sub>/search.json` and sends `restrict_sr=1`** — the mock
  serves the marker child only when `restrict_sr=1` is on the wire (this commit's fix: root
  `/search.json` has no `subreddit` param, so the prior code's `restrict_sr=1&subreddit=<name>`
  silently returned site-wide results);
- both cross-denials at the handler chokepoint; `/api/scopes` lists `reddit:read`.

## Operator-run remainder (the one acceptance leg this box cannot produce)

On a node whose egress Reddit serves (the pods: ROADMAP records the dstack pod's datacenter IP
was served `.json` with a real jar — unlike zed, which is 403'd), with a fresh logged-in reddit
jar synced for a subject:

```
curl "$NODE/oauth3/_api/version"                                  # pin == deployed commit
curl -H "Authorization: Bearer $REDDIT_READ_TOKEN" "$NODE/oauth3/api/reddit/sub/LocalLLaMA?sort=hot&limit=25" -Di -
curl -H "Authorization: Bearer $REDDIT_READ_TOKEN" "$NODE/oauth3/api/reddit/search?q=local%20llm&limit=10" -Di -
# expect ≥1 post with id,title,score,num_comments,created,permalink and x-ratelimit-* on the response
```

Deploy the branch with the mandated recipe: `bash deploy.sh <staging-node-url> staging-oa-149`
(reads the live manifest, swaps only the tarball; never hand-build one).

## Reproduce this local deployment

```
docker run -d --name oa149-runner \
  -v /run/user/1018/docker.sock:/var/run/docker.sock \
  -v ~/projects/tee-daemon:/home/swarm/projects/tee-daemon:ro \
  -v /tmp/oa149-daemon:/tmp/oa149-daemon \
  -w /home/swarm/projects/tee-daemon -p 18080:18080 \
  -e INGRESS_PORT=18080 -e TEE_DAEMON_TOKEN=oa149-local-token \
  -e DAEMON_DATA_DIR=/tmp/oa149-daemon/projects -e DAEMON_AUDIT_DIR=/tmp/oa149-daemon/audit \
  -e DAEMON_TUNNEL_DIR=/tmp/oa149-daemon/tunnels -e DAEMON_TOKEN_DIR=/tmp/oa149-daemon/tokens \
  -e DAEMON_BROKER_DIR=/tmp/oa149-daemon/broker -e DAEMON_CREDS_DIR=/tmp/oa149-daemon/creds \
  -e DAEMON_RUNTIME_DIR=/tmp/oa149-daemon/runtime \
  -e PROXY_SOCKET_DIR=/tmp/oa149-daemon/proxy -e BROKER_SOCKET_DIR=/tmp/oa149-daemon/broker-sock \
  -e DSTACK_SOCKET=/nonexistent \
  tee-test-runner:latest python3 -m proxy.main
# tarball: git archive staging-oa-149 | tar -x -C wt && tar czf oauth3.tgz -C wt/server .  (flat, handler.ts at root)
# manifest: {name:oauth3, runtime:deno, entry:handler.ts, isolation:container, oci_runtime:runc,
#            listen:{port:8080}, source:tarball://oa149, ref:staging-oa-149,
#            env:{SEAL_KEY:<64hex>, OWNER_SECRET:<hex>, PUBLIC_URL, GIT_SHA:c9e6359}}
curl -X POST localhost:18080/_api/projects -H "Authorization: Bearer oa149-local-token" \
  -F 'manifest=@manifest.json;type=application/json' -F 'files=@oauth3.tgz;type=application/gzip'
```
