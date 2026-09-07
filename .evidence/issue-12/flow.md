# Flow evidence — issue #12 (Tier 2) — nytimes browser-path availability marker

Deployed staging: `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/oauth3`
Serving commit (pinned at walk time): `a45334e` — `GET /_api/version` → `{"service":"oauth3-server","commit":"a45334e"}`

## Acceptance being asserted (from the issue body)
- [x] `GET /oauth3/api/plugins` on staging returns the `nytimes` entry carrying `"path": "browser", "available": false`; every other plugin entry keeps its current shape.
- [x] The dashboard plugin list (`server/dashboard-page.ts`) shows nytimes as **"browser-path — not available on this cookie-only instance"** instead of a normal connectable row.
- [x] A read attempt still fails loudly: `GET /oauth3/api/nytimes/items` (Bearer scoped token `tok-nytimes-…` minted through connect→approve as the rig identity) returns **HTTP 502** with the exact datadome 403 message `nytimes.ts` throws — unchanged.

## The walk (2026-08-15, real Brave via envoy bridge on :3002, flock-serialized)
1. `01-login-page.png` — navigated to `/oauth3/login`; asserted `location.href` before trusting the frame.
2. Signed in **as the rig identity**: `POST /api/login` with the userKey from `~/.paseo-secrets/swarm-userkey` → session for subject **`u-eaf13541f186c7c5f466dc04e2e5da4b`**. The login page exposes no userKey form (did:key / passkey / extension / owner only), so the minted session was placed into `localStorage['oauth3_session']` — the identical slot and value the page's own `login()` writes post-sign-in. Named honestly: this is the sign-in wall for userKey identities on this page.
3. `02-dashboard-signedin.png` — navigated to `/oauth3/dashboard`; asserted `location.href`; page shows the signed-in subject. In-frame DOM assertion of the nytimes row (`#sites .item` matching /NYTimes/i), verbatim:
   `NYTimes saved (browser-path) | browser-path | browser-path — not available on this cookie-only instance (reads need the browser, #14)`
   — the honest label renders; the row carries a `browser-path` warn pill and NO meter / "not saved" connectable-row chrome.
4. `03-nytimes-row-closeup.png` — crop of the nytimes row's live bounding rect (x493 y319 w429 h79 + 18px margin) from the same capture as step 3.

## API evidence (full transcript: `tier1-transcript.txt`)
- `GET /api/plugins` → nytimes entry: `"id":"nytimes", … "path":"browser","available":false` — every other entry has exactly the pre-#12 key set (also asserted by unit test `nytimes #12: every other plugin entry keeps its current shape`).
- connect → approve → `tok-nytimes-536c51deb43843478c8e5503` → `GET /api/nytimes/items` → **502** `{"error":"NYT blocks server-side replay (datadome 403) — nytimes is a BROWSER-PATH plugin; run it via the browser (Teleport Computer), not the frozen path"}`.

## What I could NOT verify
- I could not visually inspect the PNGs in this session (no image rendering available); they are verified non-blank and content-bearing by pixel analysis (1475 distinct colors full-page, 586 in the crop) plus the same-frame DOM text assertion above, with `location.href` asserted before each capture.
- The rig subject documented in the spec (`u-cc7f19ff9b44522c2bf725b7d02d15de`) does not match the current `~/.paseo-secrets/swarm-userkey`, which hashes to `u-eaf13541f186c7c5f466dc04e2e5da4b`. The walk used the secret actually on the box; the spec's subject line looks stale — flagging for the operator.
- Staging was already serving `a45334e` (deployed by the earlier spawn that authored the commit) — verified by the version pin above; no redeploy was performed since the branch tip equals the serving commit.
