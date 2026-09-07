# Issue #55 — Tier 2 walked flow: `/oauth3/app` connect→approve→items, extension ABSENT

**Deploy:** `staging-oa-55` @ `e4869fc`, health-gated by `deploy-staging-oauth3.sh`;
`GET /oauth3/_api/version` → `{"service":"oauth3-server","commit":"e4869fc"}` (pinned in walk-log.txt).
**Identity:** u-swarm (`u-eaf13541f186c7c5f466dc04e2e5da4b`), session over the real `POST /api/login`,
placed in `localStorage.oauth3_session` on the staging origin (where the login page keeps it).
**Browser:** envoy bridge (real Brave, real pointer events — no CDP/Playwright), single drivable tab.

## Steps (walk-log.txt has the full transcript)

1. **01-approve-link-rendered.png** — `/oauth3/app?plugin=reddit`, provider object ABSENT
   (`typeof globalThis.oauth3 === "undefined"` asserted before the click), real click on
   `#login`. Asserted: `#approve a` renders with
   `href=…/oauth3/approve/req-b654…`, and `document.body` does NOT contain
   `"extension not found"` (the old dead end). The web handshake
   (`POST /api/connect` → approveUrl) carried it.
2. **02-consent-screen.png** — navigated to the approve URL; asserted `location.href`;
   the signed-in pod room shows the consent screen (app `demo-app`, plugin `reddit`,
   capability statement, Approve/Deny).
3. **03-approved.png** — real pointer click on **Approve**; the page reports approval.
4. **04-items-rendered.png** — fresh `/app` load, provider absent, real click `#login`,
   second connect request approved; the page's own SDK poll adopted the token and rendered:
   asserted `#token` = **`scoped token ✓`**, **20 rows**, block line
   **`items 51 saved posts`** + `read with scoped token, not your cookies`.

## Acceptance asserted (issue #55 checkboxes)

- ✅ `/oauth3/app` on staging, no extension: **connect→approve→items completes and renders real
  items** (51 real saved posts) — no "extension not found" dead end; the web handshake carried it.
- ✅ `server/app-page.ts` no longer branches on the provider — the verbatim SDK `connect()` port
  decides (provider-preferred / web fallback) and renders the approve link via `onApproveUrl`.
  Regression test in `server/handler_test.ts` (no `window.oauth3` in /app HTML).
- ✅ Contract written down once: `docs/app-contract.md`.
- ✅ (otterscope half) already shipped by **webhost-apps PR #143** (merged 2026-08-15; live
  staging otterscope carries 0 `window.oauth3` occurrences) — verified at spawn, not duplicated.

## Honest notes (could NOT verify / walls)

- **Extension-absence method:** the rig's Brave has the oauth3 extension installed (it injects on
  `<all_urls>`), so the provider object was neutralized (`globalThis.oauth3 = undefined`) before
  each click. What the acceptance targets — the page itself never touching the provider — is
  enforced in source + unit test, and the web fallback demonstrably carried both runs.
- **Single bridge tab:** the bridge drives one tab, so run 1 walked the consent UI with real
  clicks, and run 2 (which must keep the page's poll alive) fired the same approve
  `POST /api/connect/:id/approve` from page context — identical endpoint, session, and body to
  the button walked in step 3.
- **Personal data (public repo):** u-swarm's reddit saved posts are real personal data. The real
  render was verified in-session (assertions above + walk-log); in the committed shot the item
  titles are covered by a labeled on-page redaction banner. No fixture/mock was shipped — the
  51 items are the real read.
- **Listing-gate fix required for the demo to work at all:** the page's app id
  (`<plugin>-demo`, unlisted) was refused by `POST /api/connect` before any approval — extension
  or not. Now uses the listed `demo-app` id (listing.ts). The consent screen therefore shows
  "Approve (dev-mode)" styling for scope steer; the minted token is a normal scoped read token.
- **Audit follow-ups (out of acceptance, reported on the issue):** `timeline-peek/index.html`
  still branches on the provider; `login-with-everything` is extension-by-design (its PRD).
