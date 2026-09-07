# #17 — Tier 0 evidence: docs/deploy.md (docs only, no behavior change)

**Tier 0: no behavior change.** The diff touches zero runtime files (`server/` untouched);
`deno check server/main.ts` clean and `deno task test` 172/172 green on `c2fe061`
(`~/paseo-batch/out/oa-17/test.log`).

## Flow 1 — each gotcha appears in the doc with the concrete value

- (a) `docs/deploy.md:111` — "Gotcha (a): `listen.port` is **8080**, not 3000 — the
  **screenshare-frames** conflict"; explains the `-3000`/`-8080` hosts and that `-8080` is baked
  into `PUBLIC_URL`.
- (b) `docs/deploy.md:127` — "an empty `container_id` does NOT mean the project is down", with
  the live `"container_id": ""` + `health=200` pair.
- (c) `docs/deploy.md:18` — "The golden rule: `GET {node}/_api/projects` FIRST — before any
  POST", with the three partial-manifest incidents (~1h original, 2026-08-10 two days,
  2026-08-12 wrong SEAL_KEY).

Reachability: README "Deploy (tee-daemon)" links `docs/deploy.md`; `docs/operator.md` §2 carries
a back-pointer; deploy.md links operator.md §1/§2/§3/§5 and plugins.md instead of duplicating them.

## Flow 2 — doc followed top-to-bottom against staging once (2026-08-15)

Executed through the doc's own "codified paths" (it says prefer the script over hands):

| doc step | result |
|---|---|
| 1. gate the tree | `deno check server/main.ts` CLEAN; `deno task test` **172 passed / 0 failed** |
| 2. flat tarball + DEPLOY_STAMP | built by `deploy-staging-oauth3.sh` (`handler.ts` at root, stamp written) |
| 3. read the live manifest first | `GET /_api/projects/oauth3` → env intact (9 keys incl. `SEAL_KEY`, `OWNER_SECRET`) → proceed |
| 4. minimal edit | only `ref=staging-oa-17`, `env.GIT_SHA=c2fe061`; bookkeeping fields stripped; env byte-identical |
| 5. POST | accepted |
| 6. health-gate + version pin | `GET /oauth3/api/health` → `{"ready":true,"plugins":[…9…]}` (200 at t+6s); `GET /oauth3/_api/version` → **`{"service":"oauth3-server","commit":"c2fe061"}`** = this branch's SHA |
| gotcha (b) liveness re-check | live record after deploy: `"container_id": ""`, `listen: {port: 8080}`, `ref: staging-oa-17` — while serving 200 |

Post-deploy live manifest (redacted) proving the preserve rule:

```json
{"name":"oauth3","entry":"handler.ts","port":3000,"listen":{"port":8080,"protocol":"http"},
 "isolation":"container","oci_runtime":"runc","container_id":"","ref":"staging-oa-17",
 "GIT_SHA":"c2fe061","env_keys":["BROWSER_SPI_SECRET","BROWSER_SPI_URL","DATA_DIR","FIX_TOKEN",
 "GIT_SHA","OWNER_SECRET","POLL_INTERVAL_MIN","PUBLIC_URL","SEAL_KEY"]}
```

**Steps that did not work as written: none.** Every command in the doc ran as documented
(the manual `GET`-first and liveness commands were also run by hand, not only inside the script).
