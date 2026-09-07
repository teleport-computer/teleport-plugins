# Tier-1 evidence — issue #16: `deploy.sh` codifies the oauth3 redeploy recipe

**Deployed ref:** `staging-oa-16` @ `62301e4` → live on webhost-staging.
**Node:** `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network`
**When:** 2026-08-15 ~19:01 UTC. Full raw logs also at `~/paseo-batch/out/oa-16/deploy-final.log` (box).

## Acceptance → evidence map

| # | Acceptance | Evidence |
|---|---|---|
| 1 | `bash deploy.sh <node-url>` with the staging daemon token redeploys oauth3; `GET .../oauth3/api/health` → 200 with the plugin list | Transcript below: POST accepted (HTTP 201), then `t+5s health=200`, body `{"ready":true,"plugins":["otter","youtube","reddit","nytimes","twitter","google-calendar","amazon","zai","hackernews"]}` |
| 2 | Post-deploy `GET {node}/_api/projects` carries every live field — `isolation: container`, `listen.port 8080`, full `env_passthrough` — diffed against the pre-deploy read; only the tarball/commit differs | Masked pre/post dumps below; `changed fields: ['deployed_at', 'env.GIT_SHA', 'tree_hash']`; verifier printed `VERIFIED: isolation=container, listen.port=8080, env_passthrough intact, env keys intact` |
| 3 | Node is a required argument; no hardcoded prod node; refuses to run without one | `bash deploy.sh` → `ERROR: node-url is required (there is no default node — refusing to guess).` exit 2; `bash deploy.sh 78ffc...network` (no scheme) → exit 2. No node URL appears anywhere in `deploy.sh` except as `$1`. |

## Version pin (Tier 1)

```
GET /oauth3/_api/version → {"service":"oauth3-server","commit":"62301e4"}
```

`62301e4` is the `staging-oa-16` commit that carries `deploy.sh` (the evidence commit adding this
file follows it; the deployed code is identical).

## Transcript (final green run, secrets masked by the script itself)

```
$ bash deploy.sh https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network staging-oa-16

==> pre-read: GET .../_api/projects (oauth3)
==> manifest-preserve (live fields carried forward untouched)
    env keys (values never printed): BROWSER_SPI_SECRET, BROWSER_SPI_URL, DATA_DIR, FIX_TOKEN, GIT_SHA, OWNER_SECRET, POLL_INTERVAL_MIN, PUBLIC_URL, SEAL_KEY
    env_passthrough: OWNER_SECRET, SEAL_KEY, OAUTH3_OWNER_SECRET, OAUTH3_SEAL_KEY, BROWSER_SPI_URL, BROWSER_SPI_SECRET
==> build staging-oa-16 (62301e4)
    (deno check server/main.ts — clean)
    verified pins: isolation=container oci_runtime=runc listen.port=8080 entry=handler.ts ref=staging-oa-16
==> POST .../_api/projects
    accepted (HTTP 201)
==> health gate: GET .../oauth3/api/health
    t+5s health=200
    body: {"ready":true,"plugins":["otter","youtube","reddit","nytimes","twitter","google-calendar","amazon","zai","hackernews"]}
    version: {"service":"oauth3-server","commit":"62301e4"}
==> post-read + verify
    --- pre  (secrets masked) ---   (see below)
    --- post (secrets masked) ---   (see below)
    changed fields: ['deployed_at', 'env.GIT_SHA', 'tree_hash']
    VERIFIED: isolation=container, listen.port=8080, env_passthrough intact, env keys intact
== staging-oa-16 (62301e4) deployed and verified on ... ==
exit 0
```

### Pre-deploy read (secrets masked)

```json
{
 "cap_add": [], "commit_sha": "", "container_id": "",
 "deployed_at": "2026-08-15T19:00:54.632424+00:00",
 "devices": [], "egress": false, "egress_provider": false,
 "entry": "handler.ts",
 "env": {
  "BROWSER_SPI_SECRET": "<masked 64 chars>",
  "BROWSER_SPI_URL": "https://d36facf2a9d92be3c1e554240861a27fcf5fcf31-3000.dstack-pha-prod7.phala.network",
  "DATA_DIR": "./data-r20260812",
  "FIX_TOKEN": "<masked 32 chars>",
  "GIT_SHA": "6240d80",
  "OWNER_SECRET": "<masked 64 chars>",
  "POLL_INTERVAL_MIN": "30",
  "PUBLIC_URL": "https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/oauth3",
  "SEAL_KEY": "<masked 64 chars>"
 },
 "env_passthrough": ["OWNER_SECRET", "SEAL_KEY", "OAUTH3_OWNER_SECRET", "OAUTH3_SEAL_KEY",
                      "BROWSER_SPI_URL", "BROWSER_SPI_SECRET"],
 "image": "", "image_digest": "sha256:d45feaa…c390e", "image_port": 0,
 "isolation": "container",
 "listen": {"port": 8080, "protocol": "http"},
 "mode": "dev", "name": "oauth3", "oci_runtime": "runc", "port": 3000, "public": false,
 "ref": "staging-oa-16", "runtime": "deno", "source": "",
 "tree_hash": "759ba11a50f07cd66458575cdb6fc00845a6b1338aeb89bccea3d93780b0ffb2", "volumes": []
}
```

### Post-deploy read (secrets masked)

Identical except — `deployed_at: "2026-08-15T19:01:23.570452+00:00"`,
`env.GIT_SHA: "62301e4"`,
`tree_hash: "ace14eb537f588d3458480ac7405dffe115100fb3d032eb243a58f17db3c390e"`.
Everything else — including the whole `env` block (SEAL_KEY/OWNER_SECRET carried byte-for-byte,
never named by the script), the 6-entry `env_passthrough`, `isolation: container`,
`listen: {port: 8080}`, `port: 3000`, `mode`, `public`, `egress` flags — is unchanged.

## State before the first `deploy.sh` run (normalization applied by the verified recipe)

When work started, the live oauth3 manifest (session probe, 2026-08-15 ~18:40 UTC, and the run-1
pre-read in `~/paseo-batch/out/oa-16/deploy-run.log`) carried:
`listen: {port: 3000, protocol: "http"}` and `oci_runtime: ""` — the only project on the node not
using path-based `listen.port 8080` (49 projects total). The first `deploy.sh` run applied the
verified pins from the issue (`listen.port` 3000→8080, `oci_runtime` ""→"runc"); every run since
diffs only on `deployed_at`/`env.GIT_SHA`/`tree_hash`.

Why `listen.port 8080` is right (and what "no port-3000 conflict" means): the daemon's ingress
routes container-isolated projects by `(container-ip, 3000)` regardless of `listen.port`, while
`listen.port != 8080` additionally claims a dedicated host port for port-based routing and makes
the daemon **hard-fail a redeploy** if any other project holds that port (`proxy/deploy.py`,
conflict check). `listen.port 8080` = path-based `/oauth3/…` routing, no dedicated port claim —
matching every sibling project (`egress-probe`, `timing-leak-demo` are `container`+`8080`+runc).

## Notes / what could NOT be verified

- **Gateway echo quirk (worked around, not fixed):** for ~1–2 min after a `POST /_api/projects`,
  a `GET` of the bare `/_api/projects` URL on the staging gateway can be answered with the POST's
  own response body (a single oauth3 object) instead of the project list. `deploy.sh` reads
  manifests with a tolerant parser and falls back to `GET /_api/projects/oauth3` (the same
  endpoint family `cli verify` uses); the post-read retries up to 6×3s. This is a daemon/gateway
  behavior — outside this repo; flagged for the operator.
- The deploy was performed by `deploy.sh` itself (its first live runs), implementing the same
  read-live/preserve-env algorithm as `~/paseo-batch/deploy-staging-oauth3.sh` (which remains the
  default worker path); the issue's operator-approved acceptance (2026-08-13) requires exactly
  this demonstration.
- Run history (all logged under `~/paseo-batch/out/oa-16/`): run 1 — flat-tarball guard tripped
  pre-POST (no state changed); runs 2–3 — deploy succeeded, verify hit the gateway echo (staging
  stayed healthy, `/_api/version` pinned each time); final run — green end-to-end as transcribed
  above. Each failed verify exited non-zero: the script fails loudly rather than reporting an
  unverified deploy.

## 2026-08-15 — rebase re-verification (post-rebase, pins refreshed)

Rebased `staging-oa-16` onto `origin/staging` @ `3c6c82a` (staging advanced through PRs #162/#161/#164/#165
while this PR waited). Only `PLAN.md` conflicted — a per-issue scratch file fully rewritten by every PR;
resolved by taking this branch's #16 plan (the #18 plan is preserved in staging history `3c6c82a`).
`deploy.sh` is **byte-identical** before/after the rebase (`git diff <old-head> <new-head> -- deploy.sh` → empty).

Re-ran the PR's own verification from the rebased head:

- `deno check server/main.ts` — clean.
- `deno task test` — **174 passed, 0 failed** (172 pre-rebase; the +2 is staging's #162 static-guard
  test now included — `~/paseo-batch/out/oa-16/test-rebase.log`).
- Live deploy re-run (`bash deploy.sh <node>` from the rebased worktree, `~/paseo-batch/out/oa-16/deploy-rebase.log`):
  - POST accepted → `t+5s health=200`, plugins list unchanged (9 plugins).
  - Read-back verify: `changed fields: ['deployed_at', 'env.GIT_SHA', 'ref', 'tree_hash']` — all
    tarball/commit-identity fields; `VERIFIED: isolation=container, listen.port=8080, env_passthrough intact,
    env keys intact`. (`ref` moved because the prior live manifest carried `staging-oa-21` from another
    worker's deploy; this run built default `HEAD` = the rebased tip.)
  - **Fresh version pin:** `GET /oauth3/_api/version` → `{"service":"oauth3-server","commit":"7a72008"}` —
    the rebased deploy.sh-carrying-state head, live at time of writing. (The pin above read `62301e4`, a
    pre-rebase SHA that no longer exists in the rebased history — superseded by this run, not deleted, so
    the trail stays honest. This evidence commit follows `7a72008`; the deployed code is identical.)
- Required-arg refusal re-checked: `bash deploy.sh` → exit 2, same message.
