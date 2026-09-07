# The app connect contract — apps call SDK `connect()`, never the extension object

**Status:** ratified (RFC 0008 §"SDK contract"). This page is the single place the contract is
written down for app authors. `rfcs/0008-extension-optional-sdk.md` has the full design.

If you are writing an app that reads a user's data through an OAuth3 instance, the rule is one
sentence:

> **Your app calls the oauth3-sdk `connect()` (with an `onApproveUrl` callback) — it never
> touches the injected `window.oauth3` provider itself. That provider is an internal detail
> between the SDK and the browser extension.**

## Why

`connect()` is **provider-preferred with a web fallback**. It decides, not your app:

| situation | what `connect()` does |
|---|---|
| oauth3 extension present | the provider carries the whole flow — copies the site's cookie jar into the user's vault if needed, approves, hands back a scoped token |
| no extension (phone, same-pod, any browser) | `POST /api/connect` → it hands your `onApproveUrl` callback an approval URL → the user approves in their signed-in OAuth3 room → the SDK polls until the scoped token comes back |

An app that branches on the injected provider itself (`if (!window.oauth3) { "extension not
found"; return }`) is **non-conformant**: it is dead on mobile and same-pod deployments even
though nothing in the flow needs the extension. That dead end is the bug this contract exists
to forbid (issue #55).

## How to comply

The instance's demo page (`server/app-page.ts`) and otterscope (webhost-apps, PR #143) are the
reference consumers. Both embed the same verbatim port of the SDK `connect()`
(`oauth3-sdk/src/index.ts`):

```js
const token = await oauth3Connect({
  node: NODE, plugin: "otter", app: "my-otter-app",
  onApproveUrl: (url) => renderApproveLink(url),   // your UI, not the SDK's
});
// token is a scoped read token: GET NODE/api/<plugin>/items with `Authorization: Bearer <token>`
```

Deno/server apps import the real SDK instead (`oauth3-sdk` on jsr/github); `feedling-web`'s
`oauth3-client.ts` is the long-running-service variant (it hand-drives the same
connect→approveUrl→poll steps so it can disconnect/reconnect race-free).

## Behavior your users see (keep it)

- **The approve link is a first-class UI state**, not an error: render the `onApproveUrl` link
  ("open your OAuth3 room to approve →") and keep the page alive — the SDK's poll completes the
  handshake in place.
- **A not-yet-synced site is a legible 409, never a dead end**: without the extension, a jar the
  vault doesn't have yields `409 "not synced to this instance yet — add it from a device with the
  extension"`. Surface that message; don't invent a fallback.
