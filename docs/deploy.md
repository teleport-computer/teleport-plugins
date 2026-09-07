# Deploy on a tee-daemon: the manifest-preserving redeploy + three gotchas

This page extends [`docs/operator.md` §2](./operator.md) (first-time deploy, trust postures,
secret delivery) — it does not repeat it. The `--deny-env` / top-level `Deno.env` crash rule
lives in [`docs/plugins.md`](./plugins.md). What only this page covers: how to **re**deploy
without taking the instance down, and the three daemon-side gotchas that have each caused a
real outage (the original memory-note this repo never had).

Examples use the staging node:

```bash
NODE=https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network
# auth: Authorization: Bearer $TEE_DAEMON_TOKEN
```

(The `-8080` in that hostname *is* gotcha (a) below.)

## The golden rule: `GET {node}/_api/projects` FIRST — before any POST

A `POST /_api/projects` **replaces the whole project manifest**. The live manifest is the only
place some fields exist — above all `env.SEAL_KEY` and `env.OWNER_SECRET`, which the daemon
injected at first deploy and which are deliberately NOT in the repo (`server/project.json` is a
minimal dev example; secrets must not land in attested source). POST a partial or hand-built
manifest and:

- `SEAL_KEY` dropped → `initVault` throws at boot → **every route 500s** (2026-08-10: the env
  block was dropped, staging was down for two days);
- a *different* `SEAL_KEY` → the sealed vault no longer decrypts → 500s again, and the evidence
  you needed to debug it is now uncollectable (2026-08-12);
- the incident that opened this issue: a partial manifest took the live instance down for ~1h.

So step one of any deploy is a read, never a write:

```bash
curl -sf "$NODE/_api/projects/oauth3" -H "Authorization: Bearer $TEE_DAEMON_TOKEN"
```

Change only what you intend to change (new tarball, `ref`, `env.GIT_SHA`), strip the
daemon-populated bookkeeping fields (`container_id`, `image_digest`, `deployed_at`,
`commit_sha`, `tree_hash`), and POST the result back with the new tarball. If the live manifest
is *already* missing `SEAL_KEY`/`OWNER_SECRET`, **refuse** — deploying over it would destroy
the only remaining copy of the key; restore the env first.

## The live manifest, field by field

Shape as served today (secrets redacted; re-fetch your own before deploying):

```json
{
  "name": "oauth3",
  "runtime": "deno",
  "entry": "handler.ts",
  "port": 3000,
  "listen": { "port": 8080, "protocol": "http" },
  "mode": "dev",
  "isolation": "container",
  "oci_runtime": "runc",
  "public": false,
  "env": {
    "POLL_INTERVAL_MIN": "30",
    "BROWSER_SPI_URL": "https://…-3000.dstack-pha-prod7.phala.network",
    "BROWSER_SPI_SECRET": "…",
    "DATA_DIR": "./data-r20260812",
    "FIX_TOKEN": "…",
    "GIT_SHA": "<short sha of the deployed tree>",
    "OWNER_SECRET": "…",
    "PUBLIC_URL": "https://…-8080.dstack-pha-prod7.phala.network/oauth3",
    "SEAL_KEY": "…"
  },
  "env_passthrough": ["OWNER_SECRET", "SEAL_KEY", "OAUTH3_OWNER_SECRET", "OAUTH3_SEAL_KEY",
                      "BROWSER_SPI_URL", "BROWSER_SPI_SECRET"],
  "container_id": "",
  "image_digest": "sha256:…",
  "deployed_at": "…", "commit_sha": "", "tree_hash": "…"
}
```

| field | why it matters |
|---|---|
| `runtime: "deno"` + `entry: "handler.ts"` | the tarball must be **flat**: `handler.ts` at the root. A nested layout with `entry: "server/handler.ts"` never resolves and the module fails to boot (2026-08-12). |
| `port: 3000` | the app's *internal* listener (`PORT` default, see the env table in operator.md §1). Not the public port. |
| `listen: {port: 8080}` | the daemon's **ingress** port — gotcha (a). Do not "fix" it to 3000. |
| `mode: "dev"` | trust posture; see operator.md §3. |
| `isolation: "container"` + `oci_runtime: "runc"` | the isolated `--deny-env` sandbox the code is written for (top-level `Deno.env` crashes it — plugins.md). |
| `env.SEAL_KEY` | 32-byte hex AES-GCM key for the cookie vault. Lose it or change it → vault bricked → 500s. Daemon-injected; **never** retype it into a hand-built manifest. |
| `env.OWNER_SECRET` | admin/bootstrap bearer. Same rule. |
| `env.BROWSER_SPI_URL` / `BROWSER_SPI_SECRET` | render-worker base + its bearer; absent → `/screenshot` 502s (issue #14). |
| `env.DATA_DIR` | where the sealed vault + tokens + audit + transcripts live — see *Persistence* below. |
| `env.GIT_SHA` | the commit the tarball was built from; `/_api/version` reports it (the Tier-1 evidence pin). |
| `env.PUBLIC_URL` | canonical external origin; embeds the `-8080` host and `/oauth3` path. |
| `env_passthrough` | names the daemon-injected secrets (aliases included) so they ride dstack-encrypted env, not the manifest text. |
| `container_id`, `image_digest`, `deployed_at`, `commit_sha`, `tree_hash` | daemon bookkeeping, populated after deploy. Strip them before POSTing; empty `container_id` is normal — gotcha (b). |

## The redeploy recipe (what `deploy.sh` / the staging script codify)

1. **Gate the tree**: `deno check server/main.ts` clean, `deno task test` green, on the ref you
   are about to ship.
2. **Build a flat tarball**: export the tree, then `tar czf oauth3.tgz -C <tree>/server .` so
   `handler.ts` sits at the root (matches `entry`). A `DEPLOY_STAMP` file recording
   `date / ref / sha` inside the tarball makes the running tree self-describing.
3. **Read the live manifest** (golden rule above). Refuse if `SEAL_KEY`/`OWNER_SECRET` are absent.
4. **Minimal edit**: strip the bookkeeping fields; set `ref` and `env.GIT_SHA`; touch nothing
   else — `env` stays byte-identical.
5. **POST** both parts:
   `curl -X POST "$NODE/_api/projects" -H "Authorization: Bearer $TEE_DAEMON_TOKEN" -F 'manifest=@m.json;type=application/json' -F 'files=@oauth3.tgz;type=application/gzip'`
6. **Health-gate**: poll `GET $NODE/oauth3/api/health` until 200 (a boot takes up to ~a minute),
   then `GET $NODE/oauth3/_api/version` and confirm `commit` equals your `GIT_SHA`. Only then is
   the deploy real. If health never greens, staging is broken — report it on the issue; do not
   collect evidence against it and do not try to "fix" it with another manifest.

## Gotcha (a): `listen.port` is 8080, not 3000 — the screenshare-frames conflict

Port 3000 on the staging node is already claimed by the **`screenshare-frames`** project (a deno
`server.ts` — its ingress is the node's `-3000` hostname, the same one `BROWSER_SPI_URL` points
at). oauth3 therefore declares `listen: {port: 8080}` and is reached on the node's `-8080`
hostname with path routing:

```
https://<node>-8080.dstack-pha-prod7.phala.network/oauth3
```

That `-8080` (and the `/oauth3` path) is baked into `PUBLIC_URL`, the extension configuration,
and every evidence URL. Resetting `listen.port` to 3000 in a redeploy collides with
screenshare-frames and silently breaks the ingress — preserve the live value, like every other
field you did not intend to change.

## Gotcha (b): an empty `container_id` does NOT mean the project is down

The daemon does not persist container ids back into the project record — a restart or redeploy
leaves `container_id: ""` while the service is happily serving. (Verified live: the staging
`oauth3` record shows `"container_id": ""` at the same moment `/oauth3/api/health` returns 200.)
Liveness is an HTTP question, not a field:

```bash
curl -s "$NODE/oauth3/api/health"     # 200 = up
curl -s "$NODE/oauth3/_api/version"   # {"service":"oauth3-server","commit":"…"} — which tree is live
```

Do not conclude "down" from an empty `container_id`; conversely do not conclude "up" from a 200
on the node root — only the `/oauth3` paths above answer for this project.

## Persistence: the vault, `DATA_DIR`, and per-identity `/api/plugins`

Everything durable lives under `env.DATA_DIR` (live value: `./data-r20260812` — note the
rotation suffix): `vault.sealed` (the AES-GCM cookie vault, jars keyed `<subject>:<plugin>`),
tokens, connect grants, audit, sessions, transcripts. Two consequences:

- Changing `DATA_DIR` (or wiping the project dir) **orphans the sealed vault** — the new path
  starts empty and every previously-synced jar is gone. Rotations are deliberate; do them
  knowingly.
- Plugin availability is per-identity: `GET /api/plugins` lists each plugin *with that signed-in
  identity's jars* (`jars: []` for anonymous). A deployed plugin only "shows up" for an identity
  whose vault holds a jar for it — see operator.md §5 for the three jar-seeding paths.

## Codified paths (prefer these over hands)

- `deploy.sh` (repo root, issue #16) — the manifest-preserving redeploy as one command.
- The paseo staging script (`~/paseo-batch/deploy-staging-oauth3.sh <ref>`) — the same recipe
  with the health gate; **workers must deploy staging through it, never a hand-built manifest.**
