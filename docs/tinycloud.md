# TinyCloud integration — how oauth3 apps write to your TinyCloud

TinyCloud is the **storage story** for oauth3-adjacent apps (operator decision 2026-08-13, after
the 2026-08-10 licensing review cleared format-matched use). oauth3 itself stays a *delegation*
service — it never stores app data. Apps that need a place to put what they read write into
**your** TinyCloud, under **your** identity, on **your** node.

The architecture is two-legged:

```
            READ leg (oauth3)                 WRITE leg (TinyCloud)
  ┌─────────┐   scoped token   ┌──────────┐    your key (`tc` profile)   ┌──────────┐
  │ otter.ai │ ◄────────────── │  oauth3  │ ───────────────────────────► │ tinycloud│
  │ (cookie  │                 │ instance │                               │   node   │
  │  sealed) │                 └──────────┘                               └──────────┘
              app never sees the cookie             app writes as you: kv + sql rows
```

An app like `otter-importer` holds an oauth3 scoped *read* token for the source (Otter) and a
TinyCloud *write* delegation/profile for the sink. Revoking the oauth3 token stops future reads;
the transcripts already in your TinyCloud stay yours.

## The node — live probe, pinned 2026-08-15

> **No undated claims rule.** Everything about deployment state below is pinned to the probe
> transcript in this section. Re-probe before relying on any of it; the node identity has already
> drifted once (planning docs quoted `did:key:z6MktYkG6…`; the live node today is
> `did:key:z6MktTz1Xbbg…`).

The live node is the `tinycloud-bakeoff` project on the webhost-staging CVM (the image project
from the 2026-07-10 storage bake-off; the former prod `/tinycloud` mount on
`pod.dstack.soc1024.com` is retired — it Rocket-404s today). Planning shorthand `{node}/tinycloud`
means "the TinyCloud project mounted on the node"; the concrete URL today:

```sh
NODE=https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/tinycloud-bakeoff
curl -s "$NODE/version"
```

Probe captured **2026-08-15 21:20 UTC**:

```json
{"protocol":1,"version":"1.4.2","features":["kv","delegation","sharing","sql","hooks","signed-urls","encryption"],"nodeId":"did:key:z6MktTz1XbbgSAzKcKXLvGi5xo1erzVB8aXwRwy9vZ8242e1","inTEE":false}
```

Read that as:

- **version 1.4.2, protocol 1** — SDK↔node require an exact integer protocol match; a CLI/SDK
  upgrade can break against this node until the node image moves.
- **features** — kv, delegation, sharing, sql, hooks, signed-urls, encryption. (Feature *listed*
  ≠ feature *working* — see the per-command verification below; `sql` writes are currently
  refused server-side.)
- **`inTEE: false`** — the node runs under the dstack *simulator*, **not** a hardware-attested
  TEE. Do not fold it into the "sealed room" story yet: unlike the oauth3 instance, this node's
  operator can see its memory/disk. Treat it as your own infrastructure, attestation TBD.

Deployment shape (from the daemon manifest): image `ghcr.io/tinycloudlabs/tinycloud-node:1.4.2`,
runc, static keys, sqlite + local blocks under a `/data` volume — one container, ~zero ops.

## The `tc` CLI — and the PATH trap

Install the client:

```sh
npm install -g @tinycloud/cli   # verified: 0.9.0
```

> ⚠️ **PATH warning:** on a stock Linux box, `tc` is **iproute2 traffic control** (`/usr/sbin/tc`,
> `qdisc`/`filter`/`class` — kernel packet shaping). It is *not* the TinyCloud client. If
> `tc qdisc` answers, you have the wrong binary. Use the npm-installed one explicitly
> (`npx tc …`, or the `node_modules/.bin/tc` path) rather than trusting a bare `tc` on PATH.
> (Both exist side-by-side on the swarm box today.)

### `tc auth` — verified 2026-08-15

Headless setup against the staging node (no browser):

```sh
tc init --key-only --name myprofile --host "$NODE"
tc auth login --method local      # owner-key posture, no OpenKey browser round-trip
tc auth status
```

`tc auth status` transcript (trimmed):

```json
{
  "authenticated": true,
  "did": "did:pkh:eip155:1:0x172D90e94de79D276De5a35E2D6DCA9ac8841f02",
  "sessionDid": "did:key:z6MkgReybHsEtUdPwewnNWjXBEESJscdFGhnFx5vkt6ccWHj#…",
  "ownerDid": "did:pkh:eip155:1:0x172D90e94de79D276De5a35E2D6DCA9ac8841f02",
  "spaceId": "tinycloud:pkh:eip155:1:0x172D90e94de79D276De5a35E2D6DCA9ac8841f02:default",
  "authMethod": "local",
  "posture": "local-owner-key"
}
```

Known non-fatal wart (seen at every sign-in, CLI and SDK alike):

```
[TinyCloudNode] account bootstrap failed: Failed to create account index schema:
SQL batch failed: 400 - SQLite error: not authorized
```

The session still works for kv; the account-index schema it fails to create is the same subsystem
that misbehaves in the sql leg below.

### `tc kv` — verified 2026-08-15

Default space:

```sh
tc kv put "swarm-docs/hello" "written by oauth3 issue #20 doc verification 2026-08-15T21:13:42Z"
# {"key":"swarm-docs/hello","written":true}
tc kv get "swarm-docs/hello"
# {"key":"swarm-docs/hello",
#  "data":"written by oauth3 issue #20 doc verification 2026-08-15T21:13:42Z",
#  "metadata":{"contentType":"text/plain","contentLength":65}}
tc kv list
# {"keys":["swarm-docs/hello"],"count":1,"prefix":null}
```

The `applications` space (where otter-importer writes) needs an explicit capability first — a
fresh session is scoped to the default space only:

```sh
tc kv put "swarm-docs/app-check" "…" --space applications
# → 401 Unauthorized Action: …:applications/kv/swarm-docs/app-check / tinycloud.kv/put

# self-grant (you hold the owner key, so you can grant your own session):
tc auth request --cap "tinycloud.kv:applications:swarm-docs/:put,get" --grant --yes
tc kv put "swarm-docs/app-check" "applications-space check 2026-08-15T21:18:50Z" --space applications
# {"key":"swarm-docs/app-check","written":true}
tc kv get "swarm-docs/app-check" --space applications
# {"key":"swarm-docs/app-check","data":"applications-space check 2026-08-15T21:18:50Z", …}
```

### `tc sql execute` — ❌ could not run on this node (pinned 2026-08-15)

DDL and writes are refused **server-side** on the deployed 1.4.2 node — for delegated CLI
sessions *and* for the raw space owner driving the node-sdk directly:

```sh
tc sql execute "CREATE TABLE IF NOT EXISTS conversation (id TEXT PRIMARY KEY, title TEXT)" \
  --db "xyz.tinycloud.listen/conversations" --space applications
# {"error":{"code":"SQL_PERMISSION_DENIED",
#   "message":"SQL execute failed: 403 - Permission denied: DDL operations require admin or write ability"}}
tc sql execute "INSERT INTO conversation (id,title) VALUES ('doc-check','issue-20')" \
  --db "xyz.tinycloud.listen/conversations" --space applications
# {"error":{"code":"SQL_ERROR",
#   "message":"SQL execute failed: 400 - SQLite error: no such table: conversation"}}
```

Reason, as far as pinned: appending `tinycloud.sql:…:{schema,write,read,admin}` caps to the
session (`tc auth request --cap … --grant --yes`) changes `tc auth caps` but the node still
returns 403; a fresh owner via `@tinycloud/node-sdk` 2.6.3 (`signIn()` with
`autoCreateSpace`) gets the identical 403, alongside the account-bootstrap "not authorized" wart
above. The permission layer that should record those grants appears not to initialize on this
build. **Consequence for otter-importer:** its `upload` leg's kv writes work; its SQL row inserts
(conversation/participant tables) are blocked on this node until the sql permission path is fixed
upstream — this is a node bug to track, not an oauth3 defect.

### `tc delegation create` — ❌ CLI path broken, ✅ SDK path verified (2026-08-15)

The CLI command dies on an empty server response even after self-granting
`tinycloud.delegation:create`:

```sh
tc delegation create --to did:key:z6MktTz1XbbgSAzKcKXLvGi5xo1erzVB8aXwRwy9vZ8242e1 \
  --path "swarm-docs/" --actions "kv/get,kv/list" --expiry 1h
# {"error":{"code":"NETWORK_ERROR",
#   "message":"Network error during delegation creation: SyntaxError: Unexpected end of JSON input"}}
```

The equivalent node-sdk flow works end-to-end on the same node (this is also the 2026-07-10
bake-off scenario): owner `alice` delegates `kv/get,list` on `swarm-docs/` to session-only `bob`;
bob **reads through it and nothing more**:

```
alice did = did:pkh:eip155:1:0x6650c1E55D004B2b0a75F92202116c07a0149c73
bob get RAW: {"ok":true,"data":{"data":"for bob 2026-08-15T21:19:22.645Z", …}}
bob put RAW: {"ok":false,"error":{"code":"AUTH_UNAUTHORIZED",
  "message":"Unauthorized Action: …:default/kv/swarm-docs/swarm-docs/intrusion.md / tinycloud.kv/put"}}
```

Two gotchas worth their ink:

- **Delegated paths are relative to the delegation path.** Alice put `swarm-docs/bob.md`; bob (delegated
  on `swarm-docs/`) reads it as `bob.md`. Asking bob for `swarm-docs/bob.md` resolves to
  `swarm-docs/swarm-docs/bob.md` → `KV_NOT_FOUND`.
- **DIDs with `#fragments` are rejected** by `createDelegation` in SDK 2.6.3 — strip the
  fragment (`did.split("#")[0]`) before delegating.

## otter-importer — the worked example

`otter-importer` (in the private `oauth3-apps` repo) is the reference "oauth3 app that writes to
your TinyCloud": it pulls Otter.ai transcripts and publishes them as Listen `conversation`s —
the same SQL + KV shape Listen's own Fireflies / Google Meet / Granola sources write.

Read leg (oauth3 — the app never holds your Otter cookie):

```sh
OAUTH3_NODE=https://<your-instance> otter-importer init        # approve once, get a scoped token
OAUTH3_NODE=https://<your-instance> OAUTH3_TOKEN=<tok-…> otter-importer scan
OAUTH3_NODE=https://<your-instance> OAUTH3_TOKEN=<tok-…> otter-importer pull
```

Write leg (TinyCloud, via `tc`, `--space applications`):

```sh
otter-importer upload     # needs `tc` auth for your space
```

What lands where, per Otter speech:

| TinyCloud target | Content |
|---|---|
| kv `xyz.tinycloud.listen/transcript/otter-<otid>` | normalized diarized transcript JSON |
| sql `xyz.tinycloud.listen/conversations`, table `conversation` | one row: id `otter-<otid>`, title, source `otter`, timestamps, inline transcript |
| sql …, table `participant` | one row per distinct speaker |

Status today: the kv leg writes to the staging node; the sql leg is blocked by the
server-side 403 above (rows can't be created until that's fixed). Revoking the oauth3 token stops
future `scan`/`pull`; the TinyCloud copy remains yours under your key.

## Privacy & ops notes (from the 2026-07-10 bake-off, still true of the deployment shape)

- **Blocks are plaintext on disk** (`/data/blocks/<space>/…` greps straight out). The node's
  `encryption` feature covers DB columns/secrets, **not** block payloads — client-side
  encryption is required for content privacy. oauth3's sealed-cookie guarantees do **not** extend
  to what an app has already written to TinyCloud, and `inTEE:false` means no hardware boundary
  either.
- Revocation and `spaces.list()` are not implemented server-side (delegation *expiry* works —
  scope delegations with `--expiry`).
- One container (sqlite + local disk, static keys) — ~zero ops, but back up `/data`.
