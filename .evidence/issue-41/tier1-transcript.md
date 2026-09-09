# oauth3-server #41 / PR #185 — Tier-1 transcript: `/capture-trace` consumers on a deployed instance

**Gate hold (auto-merge verdict, 2026-08-29T14:25Z):**
> Auto-merge gate: FAIL Tier1 required (api change): need an HTTP transcript with /_api/version
> pinned, or explicit Tier 0 justification. See paseo-batch/CONSTITUTION.md evidence tiers.

This file is that transcript. The PR's server-side change (`server/browser.ts`,
`server/twitter-actions.ts`, `server/plugins/amazon.ts`) is on every deployment's load path
(`handler.ts` imports it), so Tier 0 is not honestly available — the behavior IS exercised
end-to-end over HTTP below, against a deployed instance of this PR's exact commit, pinned via
`GET /_api/version`.

## Node (honest constraint)

The staging CVM admin token is not present on this box (`~/.tee-daemon-staging.env` absent;
no `TEE_DAEMON_TOKEN` in any environment), so a throwaway project on the shared node
(the #132/#147 pattern) was not possible. The shared core is also unwell today:

```
GET https://78ffc78c…-8080.dstack-pha-prod7.phala.network/oauth3/_api/version
-> Internal Server Error                                  (2026-08-29)
```

Instead, a **local tee-daemon at commit `9839e825`** (this repo's sibling `tee-daemon`,
built from its Dockerfile) was run on this box's rootless docker, and the throwaway projects
were deployed **through the daemon's real deploy API** (`POST /_api/projects`, manifest +
tarball multipart), getting the same deployment stack the CVM runs: per-project **container
isolation** (`denoland/deno` image, `oci_runtime=runc`, per-project network + data volume),
the daemon's **entry shim** (`_ENTRY_SHIM_DENO`: default export, `Deno.serve` on :3000,
`--deny-env` with env folded through argv), path-based ingress routing, and daemon-side
`env` injection (which is where `GIT_SHA` — the `/_api/version` pin — comes from).
Difference from staging: the node is local, and the browser bridge is a stand-in (below).

## The browser-SPI stand-in (declared, not hidden)

The real capture service (the `login-with-anything` half of #41) is **not deployed on any
branch** — the live CVM bridge has no `/capture-trace` route (verified against the deployed
bridge and every branch of that repo; see the issue #41 comment). So the bridge at
`http://10.0.0.3:9914` during this capture is a stand-in that reproduces exactly the deployed
bridge's auth contract (`fix/bridge-auth-topology`): **every control route requires
`Authorization: Bearer <BRIDGE_SECRET>`; anything else gets `401 {"error":"unauthorized"}`**
— shown as controls S0a/S0b below. `/capture-trace` is phase-controlled: `full` returns a 200
trace with a `network_log` (one reifiable X GraphQL HomeTimeline entry); `bodyless` returns a
**200 trace with NO `network_log`** — the broken capture this PR must fail loud on. It records
each control call (path, bearer-present, body length only — jar contents never recorded);
`GET /_stub/state` returns the wire log.

## Deploys (throwaway, deleted after capture)

Tarball = `git archive <sha>` of the pinned commit, flat layout (`handler.ts` at root) +
`DEPLOY_STAMP`, exactly the `deploy.sh` recipe. Manifest (secrets redacted; `listen.port=8080`
= path-based, the staging convention):

```json
{ "name": "oauth3-oa185-verif", "source": "https://github.com/teleport-computer/oauth3-server.git",
  "ref": "staging-oa-41-captrace", "commit_sha": "229f5d87a31bd0595e0a5d76e3576560d0b609a9",
  "runtime": "deno", "entry": "handler.ts", "port": 3000, "isolation": "container",
  "oci_runtime": "runc", "mode": "dev", "listen": { "port": 8080, "protocol": "http" },
  "env": { "GIT_SHA": "229f5d87…0b609a9", "OWNER_SECRET": "<throwaway>", "SEAL_KEY": "<throwaway 64-hex>",
           "BROWSER_SPI_URL": "http://10.0.0.3:9914", "BROWSER_SPI_SECRET": "<throwaway>",
           "POLL_INTERVAL_MIN": "30", "PUBLIC_URL": "http://127.0.0.1:8085/oauth3-oa185-verif" } }
```

`oauth3-oa185-base` is identical but `ref=staging`, `commit_sha=dfc02f03…bdf92f` (staging HEAD,
the pre-PR baseline). Daemon deploy API returned 201 + `image_digest` for both; health 200.

## Transcript (captured 2026-08-29, responses verbatim)

### Stub controls — the stand-in enforces the bearer like the deployed bridge

```
$ curl -s -X POST http://10.0.0.3:9914/session -H "Content-Type: application/json" -d "{}"
HTTP 401
{"error":"unauthorized"}

$ curl -s -X POST http://10.0.0.3:9914/capture-trace -H "Authorization: Bearer <wrong>" -d "{}"
HTTP 401
{"error":"unauthorized"}
```

### PR commit 229f5d8 (deployed as `oauth3-oa185-verif`)

```
$ curl -s http://127.0.0.1:8085/oauth3-oa185-verif/_api/version
{"service":"oauth3-server","commit":"229f5d87a31bd0595e0a5d76e3576560d0b609a9"}   <-- PIN = PR HEAD

$ curl -s http://127.0.0.1:8085/oauth3-oa185-verif/api/health
{"ready":true,"plugins":["otter","youtube","reddit","nytimes","twitter","google-calendar","amazon","zai","codex","hackernews"]}

$ curl -s -X POST .../api/cookies -H "Authorization: Bearer $OSTUB" \
    -d '{"plugin":"twitter","cookies":{"twid":"u%3D22847791","auth_token":"fixture-not-real"}}'
HTTP 200
{"ok":true,"plugin":"twitter","account":"22847791","count":2}

$ curl -s ".../api/twitter/debug/trace?path=browser"            (no auth)
HTTP 401
{"error":"owner only"}

$ curl -s ".../api/twitter/debug/trace?path=browser" -H "Authorization: Bearer $OSTUB"   (stub mode=full)
HTTP 200
{"op":"trace","path":"browser","url":"https://x.com/home","reified":[{"op":"HomeTimeline","method":"GET",
 "url":"https://x.com/i/api/graphql/7Nzq9tS6bZ8GqlCwBMW24w/HomeTimeline","signing_headers":{"authorization":
 "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAA…","x-csrf-token":"9f8e7d6c5b4a","x-client-transaction-id":"tXn+Example7Id8",
 "content-type":"application/json"},"post_data":null,"status":200,
 "response_body":"{\"data\":{\"home_timeline_urt\":{\"instructions\":[]}}}"}],"ops":["HomeTimeline"]}

$ curl -s http://10.0.0.3:9914/_stub/state                                                 (the wire log)
{"mode":"full","calls":[
 {"t":"…30.412Z","path":"/session","bearer":false,"bodyLen":2},        <-- S0a control (my curl)
 {"t":"…30.418Z","path":"/capture-trace","bearer":false,"bodyLen":2},  <-- S0b control (my curl)
 {"t":"…30.456Z","path":"/session","bearer":true,"bodyLen":393},       <-- the deployed app
 {"t":"…30.457Z","path":"/navigate","bearer":true,"bodyLen":28},       <-- the deployed app
 {"t":"…35.460Z","path":"/capture-trace","bearer":true,"bodyLen":2}]}  <-- the deployed app

$ curl -s ".../api/twitter/debug/trace?path=browser" -H "Authorization: Bearer $OSTUB"   (stub mode=bodyless)
HTTP 502
{"error":"browser SPI /capture-trace returned no network_log: {\"url\":\"https://x.com/home\",\"title\":\"Home / X\",
 \"dom_html\":\"<html><body><div>Home Timeline</div></body></html>\",\"screenshot\":\"iVBORw0KGgoAAAANSUhEUg=\"}"}
```

### Baseline staging HEAD dfc02f0 (deployed as `oauth3-oa185-base`)

```
$ curl -s http://127.0.0.1:8085/oauth3-oa185-base/_api/version
{"service":"oauth3-server","commit":"dfc02f0399ad7613f5bf8117b1cc488914bdf92f"}          <-- PIN = staging HEAD

(cookie sync identical: HTTP 200 {"ok":true,"plugin":"twitter","account":"22847791","count":2})

$ curl -s ".../api/twitter/debug/trace?path=browser" -H "Authorization: Bearer $OSTUB"   (stub mode=full)
HTTP 200
{"op":"trace","path":"browser","url":"https://x.com/home","reified":[{…same HomeTimeline entry…}],"ops":["HomeTimeline"]}

$ curl -s ".../api/twitter/debug/trace?path=browser" -H "Authorization: Bearer $OSTUB"   (stub mode=bodyless)
HTTP 200
{"op":"trace","path":"browser","url":"https://x.com/home","reified":[],"ops":[]}
```

### Teardown (no litter)

```
$ curl -X DELETE http://127.0.0.1:8085/_api/projects/oauth3-oa185-verif  -> {"ok": true}
$ curl    http://127.0.0.1:8085/_api/projects/oauth3-oa185-verif        -> HTTP 404
$ curl -X DELETE http://127.0.0.1:8085/_api/projects/oauth3-oa185-base   -> {"ok": true}
$ curl    http://127.0.0.1:8085/_api/projects/oauth3-oa185-base         -> HTTP 404
```

## What this proves — and the one honest nuance

- **The laundering is dead on the deployed surface.** Same fixture, same jar, same bridge:
  staging HEAD returns `HTTP 200 {"reified":[],"ops":[]}` for a bodyless 200 trace — reading
  downstream as "the site made no calls". This PR returns `HTTP 502` naming the cause
  (`browser SPI /capture-trace returned no network_log: …`). That is `requireNetworkLog()`
  (`server/browser.ts`) doing its job through `twitter-actions.browserTrace`, the route
  `GET /api/twitter/debug/trace?path=browser`.
- **Good captures are unchanged** (both commits: 200, reified `HomeTimeline` + `ops`).
- **The bearer reaches the SPI over the wire from a deployed instance** (wire log: `/session`,
  `/navigate`, `/capture-trace` all `bearer:true`; the stand-in 401s otherwise, per the controls).
  Nuance, stated plainly: on THIS route the bearer was already threaded pre-PR
  (`twitter-actions.bridge` took `secret` before this change); the bearer-threading *delta* in
  this PR is `browser.browserCaptureTrace()` itself, which today has no in-tree deployed caller
  (its callers arrive with the capture service) — that half is covered by the Tier-3 suite
  (`server/browser_test.ts`: bearer present on all three SPI calls).
- **Owner gate intact end-to-end**: no auth → 401 `owner only`.

## Gates

- `deno check server/main.ts` clean at 229f5d8.
- Full suite at 229f5d8 (fresh run, 2026-08-29): **208 passed | 0 failed**.

## Still open (unchanged by this evidence)

The capture-service half of #41 (login-with-anything: Fetch pause-at-Response, SW auto-attach,
the bridge `/capture-trace` route, CVM redeploy) and the live logged-in Reddit capture —
operator-scoped, tracked in the issue #41 comment.
