# The provider flow — connect, scoped token, token-backed read

The live demo is **[otterscope](https://pod.dstack.soc1024.com/otterscope/)** on the shared pod.
Click **Connect Otter**; the oauth3 extension shows one approval dialog and hands the app a scoped
token. The app then lists and reads your Otter conversations through the instance — **it never
receives your cookie**. This page documents exactly that flow, with the request/response shapes
(full endpoint reference: [`http-api.md`](http-api.md); the auth model behind the bearers:
[`auth.md`](auth.md)).

On the shared pod the instance lives under `/oauth3`, so below `{node}` is
`https://pod.dstack.soc1024.com/oauth3`. A dedicated instance is its own origin. The consume path
is one line (this is exactly what otterscope's `otterscope/server.ts` does):

```js
const node = location.origin + "/oauth3";
const token = await window.oauth3.connect({ node, plugin: "otter", app: "otterscope" });
// token: "tok-…" — scoped to plugin "otter", revocable, no cookie in it
const r = await fetch(`${node}/api/otter/items`, {
  headers: { Authorization: `Bearer ${token}` },
});
// 200 { "plugin": "otter", "items": [ { "id": …, "title": …, "date": …, "meta": … }, … ], "data": <same array> }
```

`window.oauth3` is injected by the extension (`provider-inject.js`); `connect({node, plugin,
subject?, app?})` returns a promise of the token. In apps you normally call the **SDK's**
`connect()` instead — it uses this provider when present and falls back to the same HTTP
handshake in a plain browser (see [the app contract](app-contract.md) and the
[oauth3-sdk README](https://github.com/teleport-computer/oauth3-sdk)).

## What happens, end to end

Two separate moves, deliberately not one extension-shaped box: **transport** (your cookie jar
moves into the sealed vault, extension → server, once) and **authorization** (the app gets a
scoped token, server → app, per approval). The cookie never crosses the second move.

```
 page                          extension (provider)                 server (vault)              page, after connect
 ────                          ────────────────────                 ──────────────              ────────────────────
 window.oauth3.connect({node,
                       plugin, app})
 ──postMessage──►              approval dialog (user gesture)
                               GET  {node}/api/plugins          ─►  plugin listed? jar state
                               POST {node}/api/cookies          ─►  vault[subject, plugin]     (transport)
                               POST {node}/api/connect          ─►  requestId
                               POST {node}/api/connect/:id/approve ─► mint scoped token
                               GET  {node}/api/connect/:id      ─►  {status:"approved", token}
 ◄──────────────────────────── token relayed ─────────────────────────────────────────────────┘
 GET {node}/api/:plugin/items  (Authorization: Bearer tok-…) ─► 200 items   (token-backed read)
```

Step by step, with shapes (as implemented in `server/handler.ts` + `server/connect.ts`):

| # | request | auth | response |
|---|---|---|---|
| 1 | `POST {node}/api/cookies` `{plugin, cookies:{name:value}}` | wallet session (extension) | jar sealed into the vault under the approver's subject — this is the only step that touches a cookie |
| 2 | `POST {node}/api/connect` `{"plugin":"otter","subject?":"…","app?":"otterscope"}` | — | `{"requestId":"req-…","approveUrl":"https://<origin>/approve/<requestId>"}` · `404` unknown plugin · `403` the app is not in the listing (or exceeds its scope) |
| 3 | `POST {node}/api/connect/:requestId/approve` | session **or** owner (the user's decision; `{"owner_secret":"…"}` in the body is the bootstrap path) | `{"ok":true,"status":"approved"}` — mints the token bound to the approver's subject |
| 4 | `GET {node}/api/connect/:requestId` | — | `{"status":"pending"}` … then `{"status":"approved","token":"tok-…"}` (token only after approval; `denied` is terminal) |
| 5 | `GET {node}/api/:plugin/items` | `Authorization: Bearer <token>` | `200 {"plugin":"otter","items":[…],"data":[…]}` (list) · `{"plugin":"otter","data":<item>}` (single, `/items/:id`) |

The approval click in the extension's dialog (step 0) is the user gesture; the extension then
runs steps 1–4 with its wallet session and relays the token back to the page. The approve page
`{origin}/approve/:requestId` is the same decision without the extension (phone, any browser).

## What the app gets — and never gets

- **Gets:** a `tok-…` scoped read token for one plugin, bound to the approver's subject,
  revocable with `DELETE /api/tokens/:token` (after which reads get `401 unauthorized`).
- **Never gets:** the cookie jar. The jar lives sealed in the vault (`AES-GCM`, `SEAL_KEY`); reads
  happen server-side against the token's subject's jar. Revoking the token cuts the app off
  without touching your site session.

## Errors a reader will actually meet on the read

`401` no/invalid token · `404` unknown plugin · `409` no jar synced yet, or jar present but not
logged in (expired) — with the extension, re-sync (its popup's *Sync jar now* or the 30-min
auto-sync) clears it · `502` the site rejected the fetch (message surfaced).

One sharp edge: a token minted through an **approved connect never sees a step-up challenge** —
the approval *is* the out-of-band consent (pre-marked at mint, `server/connect.ts`). A token
minted directly by the owner (`POST /api/tokens`) gets **one** `409 {"error":"challenge_pending",
"challengeId":…}` on its first read; the user answers `POST /api/challenge/:challengeId/approve`
and the retry succeeds. The provider flow above never trips this.

## Reference consumers

- **otterscope** (live: <https://pod.dstack.soc1024.com/otterscope/>) — the page this doc
  describes, token persisted in `localStorage`.
- **[`app-contract.md`](app-contract.md)** — the rule for app authors: call the SDK `connect()`
  (provider-preferred, web fallback), never the injected provider object directly.
- **[oauth3-sdk](https://github.com/teleport-computer/oauth3-sdk)** — `oauth3({node}).connect()
  → .plugin("otter").list()`; the provider leg of its `connect()` is exactly steps 0–4 above.
