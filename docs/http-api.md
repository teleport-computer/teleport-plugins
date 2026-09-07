# HTTP API reference

The oauth3-server default export is `handler(req, ctx)` (`server/handler.ts`) — a single
Deno request handler. It is served by `server/main.ts` (`Deno.serve`) and is directly
callable in-process for tests. Every response is JSON unless noted (HTML pages for the UI).
All JSON responses carry `Access-Control-Allow-Origin: *` and the handler answers `OPTIONS`
preflights with `204` + the allowed methods/headers, so browser clients can call it directly.

Auth is always `Authorization: Bearer <token>`. There are three kinds of token — see
[`auth.md`](./auth.md) for the full model:

| bearer kind | prefix | who holds it | what it grants |
|---|---|---|---|
| **owner secret** | (raw) `OWNER_SECRET` | the operator / extension / CLI | everything, as subject `"owner"` |
| **web session** | `sess-…` | a signed-in user (browser localStorage) | that subject's jars/tokens/links |
| **scoped token** | `tok-<plugin>-…` | an approved app | read-only `list`/`fetch` for **one** plugin, **one** subject's jar |

"Auth required" below uses those names. `session` = a `sess-` bearer; `owner` = the owner
secret; `token` = a scoped `tok-` bearer for the matching plugin; `—` = anonymous.

Errors are returned as JSON `{ "error": "<message>" }` with a non-2xx status (status noted
per endpoint). Errors are **propagated, not masked**: a site fetch failure surfaces as `502`,
an expired jar as `409`, an unknown plugin as `404`, etc.

---

## Public & health

### `GET /api/health`
- Auth: `—`
- Response: `{ "ready": boolean, "plugins": ["otter","youtube",…] }`

### `GET /api/plugins`
- Auth: `—` (anonymous sees `jar.present: false` for every plugin; a `session`/`owner`
  bearer sees its own jar status per plugin)
- Response:
  ```json
  {
    "plugins": [
      { "id": "otter", "label": "Otter", "cookieDomains": [".otter.ai"],
        "jar": { "present": true, "updatedAt": 1719…, "count": 7 } }
    ]
  }
  ```

## Cookie jars (sync a site)

### `POST /api/cookies`
- Auth: `session` **or** `owner`
- Request:
  ```json
  { "plugin": "otter", "cookies": { "sessionid": "…", "csrftoken": "…" } }
  ```
- Response `200`: `{ "ok": true, "plugin": "otter", "count": 7 }`
- `404` unknown plugin · `400` missing/invalid cookies · `401` no bearer

### `DELETE /api/cookies/:plugin`
- Auth: `session` **or** `owner`. Query `?subject=<sub>` is honored **only** when the
  bearer is the owner secret — otherwise the target is always the caller's own subject.
- Response: `{ "ok": boolean, "deleted": boolean }`

## Scoped tokens

### `POST /api/tokens`
- Auth: `session` **or** `owner`. The token is bound to the **caller's** subject (its jar),
  with the optional `app`/`subject` fields recorded as attribution only.
- Request: `{ "plugin": "otter", "subject"?: "<display hint>", "app"?: "<display hint>" }`
- Response: `{ "token": "tok-otter-…", "plugin": "otter", "subject": "<caller subject>" }`
- `404` unknown plugin

### `GET /api/tokens`
- Auth: `session` **or** `owner`. Owner sees all; everyone else sees only their own.
- Response: `{ "tokens": [{ "token","plugin","subject?","app?","createdAt","revokedAt?" }, …] }`

### `DELETE /api/tokens/:token`
- Auth: `owner` **or** `session`. Revokes (idempotent).
- Response: `{ "ok": boolean, "revoked": boolean }`
- Once revoked, reads with that token return `401` (see `verify()` in `tokens.ts`).

### `POST /api/introspect`
- Auth: scoped token in `Authorization: Bearer <token>`; unknown, revoked, or missing
  tokens are answered as inactive rather than rejected.
- Request: no body.
- Active response `200`:
  `{ "active": true, "plugin": "otter", "subject": "u-…", "app": "sink-app", "caps": [] }`
- Inactive response `200`: `{ "active": false }`
- Revoked and garbage tokens have the same inactive shape, so callers cannot probe whether a
  token was once valid. Revocation is reflected on the next introspection request without a restart.

## Connect / approval handshake (delegation)

### `POST /api/connect`
- Auth: `—` (the requesting app calls this; it does **not** hold the owner secret)
- Request: `{ "plugin": "otter", "subject"?: "<hint>", "app"?: "<hint>" }`
- Response: `{ "requestId": "req-…", "approveUrl": "https://<origin>/approve/<requestId>" }`
- `404` unknown plugin

### `GET /api/connect/:requestId`
- Auth: `—` (the app polls until a decision)
- Response `200`: `{ "status": "pending" | "denied" }`, or `{ "status": "approved", "token": "tok-…" }`
  once approved (the token is returned **only** after approval). `404` unknown request.

### `POST /api/connect/:requestId/approve`
- Auth: `session` **or** `owner`, **or** an unauthenticated caller passing
  `{ "owner_secret": "…" }` in the body (bootstrap path). The minted token is bound to the
  **approver's** identity (whose jar will be read); the app's `subject` field stays a hint.
- Response: `{ "ok": true, "status": "approved" }`
- `401` no approver · `404` unknown or already-decided request

### `POST /api/connect/:requestId/deny`
- Auth: as `/approve`. Response: `{ "ok": true, "status": "denied" }`.

### `GET /approve/:requestId`
- Auth: `—`. HTML approval screen rendered server-side (`approve-page.ts`). This is what the
  user (the data owner) sees and clicks to grant/deny.

## Reads (scoped token or owner)

### `GET /api/:plugin/items`
### `GET /api/:plugin/items/:id`
- Auth: `token` (for `:plugin`) **or** `owner`. A scoped token reads **its own subject's**
  jar; the owner secret reads `owner`'s jar.
- Response `200`: `{ "plugin": "otter", "data": <PluginItem[] | item> }`
- `401` no/invalid token · `404` unknown plugin · `409` no jar synced **or** jar present but
  not logged in (expired) · `502` the site rejected the fetch (error message surfaced)

### `GET /api/:plugin/screenshot`
- Auth: `token` (for `:plugin`) **or** `owner`. Renders a logged-in page via the configured
  Browser SPI (`BROWSER_SPI_URL`, authenticated with the `BROWSER_SPI_SECRET` bearer — both must
  ride `env_passthrough`) using the **same** sealed jar as `/items`.
- Query: `?url=<target>` (defaults to the plugin's `renderUrl`, else `https://www.<first cookieDomain>`).
- Response `200`: `{ "plugin", "url", …shot fields }` (whatever the Browser SPI returns)
- `404` unknown plugin · `401` unauthorized · `409` no jar / not logged in · `502` render error
  (incl. `browser SPI /session 401: unauthorized` when `BROWSER_SPI_SECRET` is missing/wrong — issue #14)

## Audit

> **Spec amended #120 (2026-08-05):** the audit store is now bounded — AGE 90d
> (`RETENTION_MAX_AGE_DAYS`) **and** newest 1000 rows (`RETENTION_MAX_ENTRIES`), enforced on
> every `audit()` write and again at boot (an over-policy store self-heals on next boot). This
> replaces the prior hidden cap of **5000 rows**, which had no age bound and no operator
> visibility (the ~800 KB / 5000-entry store on staging was the symptom). Collapsing repeated
> consecutive events into one summarized row is a dashboard **view** concern
> (`dashboard-page.ts`); it does not change the response shape below, which still returns the
> full per-event trail.

### `GET /api/audit`
- Auth: `session` **or** `owner`. Owner sees the whole log; everyone else sees entries whose
  `detail.subject` matches theirs.
- Response: `{ "audit": [{ "ts","action","detail" }, …] }` (most-recent first; bounded by the
  retention policy above — age 90d / newest 1000)
- Recorded actions: `cookies.sync`, `cookies.delete`, `token.mint`, `token.revoke`,
  `connect.request`, `connect.approve`, `connect.deny`, `read`, `screenshot`, `passkey.*`,
  `login.*`, `links.unlink`.

### `POST /api/audit/prune`
- Auth: `owner` only (`401 { "error": "owner only" }` otherwise).
- Applies the retention policy now and reports the audit-store size before vs. after, plus the
  reduction (if any) that ran at boot on the real on-disk store. Idempotent — on a store already
  within policy it removes `0` and reports equal before/after.
- Response `200`: `{ "before": {"entries","bytes"}, "after": {"entries","bytes"},
  "removed": <n>, "policy": {"maxAgeDays":90,"maxEntries":1000},
  "boot": {"before":<n>,"after":<n>,"removed":<n>} | null }`.

## Sign-in, account, linking

### `GET /api/me`
- Auth: `—` (reflects the caller if any)
- Response: `{ "signedIn": bool, "subject"?: string, "providers": {github,google,openkey},
  "links": ["gh:123",…] }`

### `POST /api/login`
- Auth: `—`. Three identity paths, all → a session subject:
  - `did:key` — `{ "did","challenge","signature" }` (challenge from `/api/login/challenge`)
  - `userKey` — `{ "userKey": "<≥16 chars>" }` → subject `u-<sha256(userKey)[:32]>`
  - owner — `{ "owner_secret": "…" }` → subject `"owner"`
- Response: `{ "ok": true, "subject": "<…>", "session": "sess-…" }`
- `401` bad/expired challenge, short userKey, or wrong owner secret

### `POST /api/logout`
- Auth: `session` (bearer). Response: `{ "ok": true }`.

### `GET /api/login/challenge`
- Auth: `—`. Response: `{ "challenge": "<nonce>" }` (for did:key sign-in).

### Federated login

| endpoint | method | auth | response |
|---|---|---|---|
| `/api/login/providers` | GET | `—` | `{ github: bool, google: bool, openkey: true }` |
| `/api/login/github` | GET | `—` | `{ "url": "<github authorize url>" }` (client navigates) |
| `/api/login/github/link` | POST | `session` | `{ "url": … }` (links to the signed-in subject) |
| `/api/login/github/callback` | GET | `—` | HTML landing page; sets `localStorage` session on success |
| `/api/login/google` `/…/link` `/…/callback` | — | same as GitHub | same shape; subject `google:<sub>` |
| `/api/login/openkey/nonce` | GET | `—` | `{ "nonce","domain","uri" }` |
| `/api/login/openkey` | POST | `—` | body `{ "message","signature" }` → `{ "ok","subject","session" }` |
| `/api/login/openkey/link` | POST | `session` | links `did:pkh:eip155:1:<addr>` to the signed-in subject |

Federated provider routes exist **iff** their creds are present in the env (`GITHUB_CLIENT_ID/SECRET`,
`GOOGLE_CLIENT_ID/SECRET`); otherwise `404 { error: "<provider> login not configured" }` and the
login page omits the button. OpenKey is client-side SIWE, always available.

### `POST /api/links/unlink`
- Auth: `session`. Body: `{ "providerId": "gh:123" }`. Lockout-safe: a federated-rooted subject
  must keep ≥1 remaining factor (links + passkeys); root subjects (`u-`/`did:key:`/`owner`) always
  keep their secret door.
- Response: `{ "ok": true }` · `404` not your link · `409` would unlink your only sign-in method

### Passkey (WebAuthn)

| endpoint | method | auth | notes |
|---|---|---|---|
| `/api/passkey/register/options` | POST | `session` | `{ "challenge","rpId","userId" }` |
| `/api/passkey/register` | POST | `session` | verifies attestation, stores credential |
| `/api/passkey/login/options` | POST | `—` | `{ "challenge","rpId","allowCredentials" }` |
| `/api/passkey/login` | POST | `—` | verifies assertion → `{ "ok","subject","session" }` |
| `/api/passkeys` | GET | `session` | `{ "passkeys": [ … ] }` for the signed-in subject |

`rpId`/`origin` derive from `PUBLIC_URL`, so passkeys work behind the daemon proxy.

---

## Smoke-check → endpoint map

How the smoke checks in [`SMOKE-CHECKS.md`](../SMOKE-CHECKS.md) map to this API. There is
**no automated test suite yet**; the verification evidence today is the live end-to-end runs
recorded in `SMOKE-CHECKS.md` (M1) plus `deno check server/main.ts`.

| smoke check | endpoints / surface |
|---|---|
| **S1** no-install cookie read | `POST /api/cookies` → `POST /api/tokens` → `GET /api/:plugin/items` (CLI: `cli sync/token/read`) |
| **S2** extension ingest | `POST /api/cookies` (extension auto-syncs on cookie-change + 30m) |
| **S3** connect & grant | `POST /api/connect` → `GET /approve/:id` (user) / `POST /api/connect/:id/approve` → `GET /api/connect/:id` (poll) → `GET /api/:plugin/items` (token) → `DELETE /api/tokens/:token` |
| **S4** app delivers value | same as S3; the app holds only the `tok-…` |
| **S5** browser capture | `GET /api/:plugin/screenshot` (Browser SPI; worker unbuilt — M2) |
| **S6** add a site | the [`Plugin` interface](./plugins.md) + `registry.ts` (no endpoint) |
| **S7** app gets listed | not built (#6) |

## CORS & headers

- All JSON responses: `Access-Control-Allow-Origin: *`, `Content-Type: application/json`.
- `OPTIONS` preflight → `204` with `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
  and `Access-Control-Allow-Headers: Content-Type, Authorization`.
- Unknown path/method → `404 "not found"` (plain text).
