# Architecture

The runtime model in one page: how the server is sandboxed and fed its secrets, how every
caller collapses to a single `subject`, how credentials are keyed and sealed, and how requests
actually reach the app. Four sections, each naming the file that implements it.

For *who may call what* — the owner secret vs web session vs scoped-token bearer table — see
[`auth.md`](./auth.md); this page does not restate it.

## 1. Isolated deno runtime + `env_passthrough` secret injection — `server/project.json`

The deploy unit is a tee-daemon project, not a bare process. The manifest
([`server/project.json`](../server/project.json); the live staging equivalent is shown field-by-field
in [`deploy.md`](./deploy.md)) declares:

```json
{
  "runtime": "deno",
  "entry": "handler.ts",
  "isolation": "container",
  "env": { "POLL_INTERVAL_MIN": "30", "BROWSER_SPI_URL": "…" },
  "env_passthrough": ["OWNER_SECRET", "SEAL_KEY", "OAUTH3_OWNER_SECRET", "OAUTH3_SEAL_KEY",
                      "BROWSER_SPI_URL", "BROWSER_SPI_SECRET"]
}
```

Two env channels, deliberately split:

- **`env` (shared, committable):** plain config — poll interval, the Browser SPI base URL. Safe to
  read into the manifest text because it is not a secret.
- **`env_passthrough` (injected, never committed):** `OWNER_SECRET` and `SEAL_KEY` (plus aliases and
  the SPI bearer) would land in attested source if written into the manifest. Instead the daemon
  injects them at container start from its own dstack-encrypted env. Caveat: the daemon honors
  `env_passthrough` for the `image` runtime today, not isolated deno (tee-daemon `ISSUES.md` #13) —
  until that lands, at-rest protection rests on dstack LUKS2 + per-project volume isolation.

The container runs deno under **`--deny-env`** (`isolation: "container"` + `oci_runtime: "runc"` in
the live manifest), so the code must never touch `Deno.env` at module top level — env reaches the
handler only via its call context (`handler(req, { env, dataDir })`, [`server/main.ts`](../server/main.ts);
plugins get `ctx.env`, see [`plugins.md`](./plugins.md)). A top-level env read throws `NotCapable`
and the module never boots (issue #49's repro: [`server/_deny_env_probe.ts`](../server/_deny_env_probe.ts);
enforced by `server/boot_deny_env_test.ts` + `server/top_level_env_test.ts`). Boot also fails fast
if `DATA_DIR` is set without a `SEAL_KEY` — the vault cannot be sealed otherwise (`server/main.ts`).

## 2. Multi-tenant identity: everything resolves to a `subject` — `server/identity.ts` + `server/links.ts`

One string — the **subject** — is the tenant key everywhere downstream: `"owner"`, `u-…`,
`did:key:…`, `gh:<id>`, `google:<sub>`, `did:pkh:eip155:1:<addr>`. Jars, tokens, links, passkeys,
and audit entries are all keyed by it. Three bootstrap paths converge on it in `POST /api/login`
([`server/handler.ts`](../server/handler.ts)):

- **did:key** — the server issues a nonce challenge; the client signs it with its Ed25519 key and
  the server verifies (`server/identity.ts`). The session subject *is* the `did:key:…`. The server
  only ever sees the public DID + signature.
- **userKey** — a ≥16-char localStorage secret hashed into the subject: `subject = "u-" +
  sha256hex(userKey)` (`server/handler.ts`). No signature, no account — the cheapest identity.
- **owner** — presenting the `OWNER_SECRET` bearer yields the admin subject `"owner"`.

Federated provider ids (`gh:123`, `google:<sub>`, …) are *aliases*, not subjects: login resolves a
provider id through the link table (`server/links.ts`, `linkResolve`) to the subject it was bound
to; an unlinked provider id **is** a fresh subject. Linking only happens from an already-signed-in
session, so the weakest linked method becomes the floor (see the security note in `links.ts`).
Root subjects (`u-…`, `did:key:…`, `owner`) always keep their own door and cannot lock themselves
out by unlinking.

Which bearer proves which subject on a given request — the three-bearer precedence table — is
[`auth.md`](./auth.md)'s job; see there.

## 3. The vault: sealed cookie jars keyed per identity — `server/vault.ts`

Site cookie jars (the raw credential) are sealed at rest with AES-GCM under `SEAL_KEY` in
`DATA_DIR/vault.sealed` — never written in plaintext. The store is keyed by identity **and** plugin:

```ts
// server/vault.ts
const keyOf = (subject: string, plugin: string, account: string) => `${subject}:${plugin}:${account}`;
```

`(subject, plugin)` is the resolution unit: `getJar(subject, plugin)` with no account returns the
jar if exactly one exists, `null` if none, and throws `AmbiguousAccountError` (surfaced as HTTP 409
listing the accounts) if the identity holds more than one — it never guesses. The third part,
`account`, is *derived* from the jar itself (`plugin.accountId`, or `"default"`), letting one
identity hold e.g. a personal and a bot account for the same plugin without clobbering. Keys are
parsed from the right because subjects may themselves contain colons (`did:key:…`, `gh:…`); the
on-disk shape is `{ v: 3, store }` with automatic migration from the legacy 1- and 2-part keys
(`initVault`).

## 4. Ingress: gateway path-routing on `listen.port 8080` — `server/main.ts`

The app itself listens internally on `PORT` (default 3000) via `Deno.serve`
([`server/main.ts`](../server/main.ts)) — that is the manifest's `port: 3000`, *not* the public port.
The public edge is the tee-daemon gateway: the live manifest declares `listen: { "port": 8080,
"protocol": "http" }`, so the project is reached on the node's `-8080` hostname with **path routing**
under `/oauth3`:

```
https://<node>-8080.dstack-pha-prod7.phala.network/oauth3
```

Why 8080: port 3000 on the staging node is already owned by the `screenshare-frames` project;
resetting `listen.port` in a redeploy collides with it and silently breaks ingress
([`deploy.md`](./deploy.md) gotcha (a) — preserve the live value). That host + `/oauth3` path is
baked into `PUBLIC_URL`, the extension configuration, and (derived from `PUBLIC_URL`) the passkey
`rpId`/origins in `server/handler.ts`.

## File map

| Concern | File |
|---|---|
| Manifest: runtime, isolation, env split | `server/project.json` (live shape: `docs/deploy.md`) |
| Entry + internal listener + boot guards | `server/main.ts` |
| Request routing + subject resolution at the edge | `server/handler.ts` |
| did:key challenge/signature identity | `server/identity.ts` |
| Provider-id → subject link table | `server/links.ts` |
| Sealed per-identity jar store | `server/vault.ts` |
| Gateway ingress + redeploy gotchas | `docs/deploy.md` |
