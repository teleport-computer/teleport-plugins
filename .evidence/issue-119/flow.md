# #119 — Dashboard token hygiene: group-by-app + bulk revoke — Tier 2 evidence

Walked 2026-08-16 by the rework worker (PR #146 rebased onto `origin/staging` as `c4499de`
and deployed to staging before the walk).

## Acceptance (verbatim from issue #119)
> 1. **Probes name and clean up after themselves.** A token minted by the flows loop carries a
>    non-empty `app` (e.g. `loop-probe`) and is revoked via `DELETE /api/tokens/:token` when the
>    probe finishes. Prove it with a before/after count from the same query this issue used: the
>    `(unnamed app)` total must not grow across two consecutive sweeps.
> 2. **The dashboard is legible at volume.** APPS & TOKENS groups by app rather than listing every
>    token flat.
>
> Evidence: Tier 2 — screenshots of APPS & TOKENS before and after, plus the two sweep counts.

## Deployed node + commit pin
- Staging: `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network/oauth3`
- `GET /oauth3/_api/version` → `{"service":"oauth3-server","commit":"c4499de"}` — this PR's rebased
  head, deployed via `~/paseo-batch/deploy-staging-oauth3.sh` (manifest-preserving; SEAL_KEY /
  OWNER_SECRET carried over untouched). Pinned in `04-version-pin.png`.
- Local re-verification after the rebase: `deno check server/main.ts` → exit 0;
  `deno test --allow-net --allow-read --allow-write --allow-env` → **182 passed, 0 failed**.

## Item 1 — probes name and clean up (sweep counts, from the audit trail + live query)
The loop-side fix (probe-flows.py mints with `app:"loop-probe"` and DELETEs after read) shipped
before this PR; this walk verifies it honestly with the issue's own query and the server's
append-only audit log (owner bearer, same host-local mechanism `run-sweep.sh` uses):

- **Issue baseline (2026-08-05, pre-fix):** 1332 tokens, **127 unnamed**.
- **Now (2026-08-16, post-fix, after ~22 scheduled sweeps):** live unnamed = **4** (legacy
  pre-fix tokens; the retention/cap half is operator-blocked on #122 per the issue comments).
- **Last three consecutive sweeps** (`2026-08-15T01Z`, `2026-08-15T13Z`, `2026-08-16T01Z`, cron
  `0 8,20 * * *`): each minted exactly **2 named `loop-probe` tokens** (audit `token.mint`
  events, `app=loop-probe`, plugin `youtube`, subject `u-eaf13541f186…`) — and **zero tokens with
  an empty `app` have been minted since the first loop-probe mint**. No `loop-probe` tokens remain
  live (each sweep's probes are revoked after read), so the unnamed total **does not grow across
  sweeps** — 127 → 4 and flat.

## Item 2 — dashboard legible at volume (signed-in walk, envoy/neko rig — no CDP)
Driven via the envoy bridge (real Brave in the neko container, real pointer events). Navigation
asserted before every capture (`location.href` checks per LESSONS). Signed in as the rig identity
`u-eaf13541f186c7c5f466dc04e2e5da4b` — the key in `~/.paseo-secrets/swarm-userkey` (the
CONSTITUTION names an older subject string, `u-cc7f19ff…`; the file's live subject is this one,
same identity the flows loop probes).

Honesty note on sign-in: this login page has **no visible userKey input field** (its default is a
did:key generated in-browser). The userKey API path exists (`POST /api/login {userKey}`), so the
walk invoked the page's own `login()` with the rig key — the page's real fetch/session/redirect
code path, no mock and no fixture. Filed as a UX gap for the operator, not papered over.

State at walk time: **21 live tokens across 8 apps** (a labeled disposable `rw146-walk` group of 3
was minted owner-side first, exactly like the loop mints, so the bulk-revoke could be exercised
without touching any real app's tokens).

1. `01-dashboard-signed-in.png` — dashboard top, signed in: subject rendered in the header,
   "instance ready — <staging host>".
2. `02-apps-token-groups.png` — **APPS & TOKENS grouped by app**: `rw146-walk (3 tokens)`,
   `demo-app (3 tokens)`, `reddit-karma (1 token)`, `otterscope (4 tokens)`, `(unnamed app)
   (1 token)`, `cart-share (6 tokens)` — each group with a per-app token count and a
   **"revoke all"** button, individual `revoke` buttons retained per token. (DOM probe at capture
   time: 8 `[data-app-group]` groups, every one with `[data-revoke-app]`.)
3. `03-after-bulk-revoke.png` — after a real pointer click on `rw146-walk`'s "revoke all":
   the group is gone, 7 groups / 18 tokens remain, no error banner. Server-side confirmation via
   the API: all three `rw146-walk` tokens now carry `revokedAt` (true, true, true); live total
   back to 18.
4. `04-version-pin.png` — `/_api/version` showing `c4499de`.

All four PNGs verified non-blank (`test -s` + PNG decode: 1920×947, 217–256 unique sampled byte
values each — rendered content, not a blank frame).

## What was NOT verified
- The **retention/cap half** (pruning the 4 legacy unnamed tokens) — explicitly out of scope,
  blocked on design proposal #122 per the operator's issue comments.
- `login-with-everything` (1058 of the 1332 at issue time) — the issue's scope note says do NOT
  fix it here; its count is now part of the named-app totals above (it names its tokens).
- The sweep cadence itself is operator-run (cron on zed); this walk read the last three sweeps'
  results from the audit trail rather than waiting ~12h to observe two fresh ones. The counts above
  are real server data, not projections.
