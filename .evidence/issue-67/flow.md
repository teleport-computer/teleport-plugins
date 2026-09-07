# Tier 2 walk — issue #67: signed-in users reach the dashboard in one click

- **Deployed staging**: `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/oauth3`
- **Version pin**: `GET /oauth3/_api/version` → `{"service":"oauth3-server","commit":"159a02d"}` (the code commit of this PR; the only commit after it on the branch adds this evidence, no code)
- **Driven by**: the envoy bridge (real Brave, real pointer events for the click), `flock /tmp/envoy-bridge.lock`.
- **Identity**: the box rig identity from `~/.paseo-secrets/swarm-userkey`, provisioned over the live
  API (`POST /api/login {"userKey"}` → subject `u-eaf13541f186c7c5f466dc04e2e5da4b`), session landed in
  `localStorage.oauth3_session` exactly as the login page's own success path does.
  Note: the CONSTITUTION's `u-cc7f…` subject literal is stale — `flows/subjects.json` and the issue-#87
  walk agree the rig key yields `u-eaf1…`. Flagged in the PR.

## Acceptance, asserted

1. **Signed in (valid `oauth3_session`), `/oauth3/` primary CTA reads "Go to your dashboard"; one click lands on `/oauth3/dashboard`.**
   - DOM asserted at capture: `#cta.textContent === "Go to your dashboard"`, `#cta[href] === "dashboard"`
     (resolves against `<base href="/oauth3/">`).
   - One real pointer click on `#cta` → `location.pathname === "/oauth3/dashboard"` → dashboard rendered
     the signed-in subject in `#acct` and the Sign-out control.
   - Shots: `02-signed-in-landing.png`, `03-dashboard-one-click.png`.
2. **Signed out, `/oauth3/` unchanged — "Sign in to this pod" → `/oauth3/login`.**
   - localStorage cleared (after logging what was there), page re-driven.
   - DOM asserted: `#cta.textContent === "Sign in to this pod"`, `#cta[href] === "login"`.
   - Shot: `01-signed-out-landing.png`.
3. **Footer "Sign in" link consistent — no page shows both a sign-in and a signed-in CTA.**
   - Signed in: footer link is `Dashboard` → `dashboard`; `document.body.textContent.indexOf("Sign in to this pod") === -1`.
   - Signed out: footer link stays `Sign in` → `login` (visible in `01-signed-out-landing.png`).

## What could NOT be verified

- I did not eyeball the PNGs (no image viewing in this session); each shot is instead backed by the
  DOM assertions above, evaluated in the live page at capture time, plus non-blank pixel checks
  (hundreds of distinct scanlines per shot; 01/02/03 mutually differing).
- The CTA swap validates the session via `api/me`; a network failure there leaves the signed-out CTA
  and logs the fetch rejection — that failure path was not separately exercised.
