# Operator guide

Running your own oauth3-server. There are three trust **postures** (dev / source-bound /
attested), one bootstrap secret, one seal key, and three ways to seed a cookie jar.

## 1. Local dev

```bash
cp .env.example .env
# generate two secrets (do NOT commit them):
echo "OWNER_SECRET=$(openssl rand -hex 32)" >> .env
echo "SEAL_KEY=$(openssl rand -hex 32)"      >> .env   # 32-byte hex (64 chars)
deno task start          # server/main.ts, Deno.serve on 0.0.0.0:$PORT (default 3000)
```

Required/used env (see [`.env.example`](../.env.example) and `server/handler.ts → init`):

| var | purpose |
|---|---|
| `OWNER_SECRET` | admin/bootstrap bearer (a.k.a. `OAUTH3_OWNER_SECRET` / `EXT_SHARED_SECRET`) |
| `SEAL_KEY` | 32-byte hex AES-GCM key for the cookie vault (a.k.a. `OAUTH3_SEAL_KEY`) |
| `PORT` | default `3000` |
| `DATA_DIR` | where sealed vault, tokens, connect, audit, sessions, links, passkeys, transcripts live; default `./data` |
| `POLL_INTERVAL_MIN` | background scheduler cadence; default `30` |
| `PUBLIC_URL` | canonical external origin (passkey rpId/origin, OAuth redirect URIs); strip trailing `/` |
| `BROWSER_SPI_URL` | the Browser SPI base for `/screenshot` (render worker); blank → `502` on use |
| `BROWSER_SPI_SECRET` | shared bearer the Browser SPI requires on every control endpoint (`/session`, `/screenshot`, …); blank → SPI returns `401` and `/screenshot` surfaces `502 browser SPI /session 401: unauthorized`. It is a **secret** — rides `env_passthrough`, never the manifest `env`. |
| `OWNER_NAME`, `SOURCE_URL`, `OWNER_EMAIL`, `ATTESTATION_URL`, `INSTANCE_MODE` | copy on the public home/privacy/terms/evidence pages |
| `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET` | federated login creds (else those routes `404`) |
| `OTTER_BASE`, `GITHUB_OAUTH_BASE/API_BASE`, `GOOGLE_*_BASE` | per-plugin/provider overrides (for e2e mocks) |

`deno task dev` runs the same with `--watch`. To type-check without running:
`deno check server/main.ts` (must be clean before any deploy).

## 2. Deploy on a tee-daemon (dstack webhost)

oauth3-server runs as a tee-daemon **project** (no dedicated CVM).
[`server/project.json`](../server/project.json):

```json
{
  "runtime": "deno",
  "entry": "handler.ts",
  "isolation": "container",
  "mode": "dev",
  "env": { "POLL_INTERVAL_MIN": "30" },
  "env_passthrough": ["OWNER_SECRET", "SEAL_KEY"]
}
```

> The snippet above is the **minimal dev** example; the shipped `project.json` also passes
> through the `OAUTH3_OWNER_SECRET`/`OAUTH3_SEAL_KEY` aliases **and**
> `BROWSER_SPI_URL`/`BROWSER_SPI_SECRET` (the SPI secret is mandatory — see the env table above
> and issue #14). Copy the live file, not this snippet, when deploying.

Ship a build (use the script — it reads the live manifest first and carries every field
forward, so a redeploy can never drop the daemon-injected secrets):

```bash
bash deploy.sh https://your-daemon.dstack.phala.network [git-ref]
# token: $TEE_DAEMON_TOKEN or ~/.tee-daemon-staging.env
```

The script pins the verified manifest (`isolation: container`, `oci_runtime: runc`,
`listen: {port: 8080}` — path-based routing, no dedicated host port to conflict on),
builds a flat tarball (`handler.ts` at the root, `deno check`-gated), POSTs it, then
health-gates `/oauth3/api/health` and verifies the read-back manifest. The manual
equivalent (do not use — this is how the env got wiped on 2026-08-10):

```bash
TOKEN=…; CVM=https://your-daemon.dstack.phala.network
tar czf oauth3.tgz -C server .
curl -X POST $CVM/_api/projects -H "Authorization: Bearer $TOKEN" \
  -F 'manifest=@server/project.json;type=application/json' -F "files=@oauth3.tgz"
```

**Secret delivery.** `OWNER_SECRET`, `SEAL_KEY`, and `BROWSER_SPI_SECRET` must **not** be
committed (they would land in the attested source tree). `project.json` lists them under
`env_passthrough` so the daemon injects them from its own dstack-encrypted env.
`BROWSER_SPI_SECRET` rides `env_passthrough` for the same reason: `browser.ts` sends it as the
`Authorization: Bearer` on every SPI call, so if it is absent the render path 502s with
`browser SPI /session 401: unauthorized` (issue #14). **Today** the daemon honors `env_passthrough`
for the `image` runtime but not yet for isolated deno (`tee-daemon` `ISSUES.md` #13, ~4-line
fix). Until that lands: deploy as an `image` runtime, **or** rely on dstack LUKS2 +
per-project volume isolation for at-rest protection (the daemon derives `SEAL_KEY` from TEE
material via `GetKey → HKDF` in the intended design).

> **Redeploying an existing instance?** The manifest-preserving redeploy recipe and the three
daemon-side gotchas live in [`deploy.md`](./deploy.md): why `listen.port` is **8080** (the
screenshare-frames project owns port 3000 on the node), why an empty `container_id` in
`/_api/projects` does **not** mean the project is down, and the read-the-live-manifest-first
rule (`GET {node}/_api/projects` before any POST — a partial manifest wiped the live env and
500’d the instance for hours). This section covers first-time deploy; that page covers keeping
it up.

## 3. Trust postures (dev / source-bound / attested)

These are not three switches on one config — they are three increasingly strong claims an
operator can make, and a relying party can check:

### dev (default)
`project.json` `"mode": "dev"`; `INSTANCE_MODE` unset or `"dev"`. The evidence page
(`/evidence`) reads `INSTANCE_MODE` and shows **dev** with the honest caveat: *"the
measurement isn't pinned yet, so treat the trust story as in-progress (issue #32)."* Nothing
is attested. This is what local dev and the current hosted pod run.

### source-bound (the federation primitive, available today)
A **client** pins its trust to a specific source tree before talking to an instance. The
operator publishes their tree hash (from the daemon); the client checks it against an
allowlist — *trust the code, not the operator*:

```bash
deno run -A cli.ts verify --daemon https://a-daemon.example --project oauth3 \
  --allow <tree_hash_1>,<tree_hash_2>      # ✓ TRUSTED / ✗ UNTRUSTED (exit 2)
```

`cli verify` does `GET <daemon>/_api/projects/<project>` and compares the returned
`tree_hash` to the allowlist; it also prints `mode` and `commit_sha`. This is purely
client-side enforcement — the operator cannot override it.

### attested (in progress — issue #32)
`INSTANCE_MODE=attested`. The **running** code is measured by the TEE and the measurement is
pinned to the enclave, so a relying party can confirm the instance actually executes the
source it claims. **Not yet live** — tracked in issue #32; the evidence page reflects this
honestly. When it lands, `attested` is what makes the source-bound check non-circumventable.

## 4. Evidence / verification endpoint

The issue names `GET /_api/verification/<app>` as the verification surface. **It does not
exist on oauth3-server itself** — verification today is done against the **hosting
tee-daemon**, not this app:

| what | where | returns |
|---|---|---|
| daemon project measurement | `GET <daemon>/_api/projects/<project>` | `{ "tree_hash", "mode", "commit_sha", … }` |
| client pin check | `cli verify --daemon … --project … --allow <hash,…>` | `✓ TRUSTED` (exit 0) / `✗ UNTRUSTED` (exit 2) |
| human-facing evidence page | `GET /evidence` on the oauth3 instance | HTML: source URL, enclave app id, `INSTANCE_MODE` (dev/attested) |

So the conceptual `/_api/verification/<app>` is, today, the **daemon's**
`/_api/projects/<project>` lookup plus the client-side allowlist. There is no per-app
verification route on oauth3-server to document beyond the three rows above; if a future
issue adds one, it belongs in [`http-api.md`](./http-api.md).

## 5. Seeding a cookie jar for a new instance

Three ingest paths (smoke checks S1/S2 + the API-key path). All write the same sealed vault
(`DATA_DIR/vault.sealed`, keyed `<subject>:<plugin>`).

**A. Paste-cookie (no extension, no browser) — S1.** Copy the cookie from DevTools
(Application → Cookies) and POST it as the owner (or a session):

```bash
curl -s localhost:3000/api/cookies \
  -H "Authorization: Bearer $OWNER_SECRET" -H 'Content-Type: application/json' \
  -d '{"plugin":"otter","cookies":{"sessionid":"…","csrftoken":"…"}}'
# → {"ok":true,"plugin":"otter","count":2}
# or, equivalently:
deno run -A cli.ts sync otter --cookie 'sessionid=…,csrftoken=…' --owner $OWNER_SECRET
```

**B. Extension (auto-sync) — S2.** Load `oauth3-extension` unpacked, set the instance URL +
owner secret, pick the plugin, **Sync jar now**. It then re-syncs on cookie-change + a 30m
alarm, keeping the jar fresh with no further action.

**C. API key (no cookie at all).** For sites that take an API key (e.g. GitHub/Anthropic),
store it as a secret in `oauth3-enclave` (`POST /secrets`); a scoped-fetch capability injects
it. No cookie jar is involved — out of scope for the cookie-plugin demo.

After seeding, verify the read path end-to-end before declaring the instance live:

```bash
deno run -A cli.ts token otter --subject smoke --owner $OWNER_SECRET   # → tok-otter-…
deno run -A cli.ts read  otter --token tok-otter-…                     # real data, no raw cookie
```

The background scheduler (`server/scheduler.ts`) polls every synced, logged-in jar every
`POLL_INTERVAL_MIN` and writes new items to `DATA_DIR/transcripts/<subject>/<plugin>/`. A bad
fetch or an expired jar on one tick logs and lets the next interval retry — the loop itself
stays alive (one failure does not wedge the others).
