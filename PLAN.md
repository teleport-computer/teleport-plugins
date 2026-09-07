# PLAN — oauth3-server #149 (base staging)

Issue: "reddit: add subreddit listing + search read + reddit:read scope"

## Acceptance (from issue body — verbatim, the gate checks this)
- On deployed staging, a subject with a fresh reddit jar and a `reddit:read` token:
  `GET /api/reddit/sub/<name>?sort=hot&limit=25` returns ≥1 post carrying id, title, score,
  num_comments, created, permalink; `GET /api/reddit/search?q=<term>&limit=10` returns matches
  in the same shape plus subreddit.
- `reddit:read` defined in `server/scopes.ts` reading `["sub","search"]`, in `GET /api/scopes`,
  label names the session-attribution trade-off.
- `PLUGIN_CAPABILITIES.reddit.statement` amended (CAN clause); CANNOT clause unchanged.
- Confinement both ways (karma↛listings, read↛account/items), tests in `server/plugins/reddit_test.ts`.
- `x-ratelimit-used|remaining|reset` passed through verbatim; absent upstream ⇒ absent downstream.
- Jar-less/rotted jar ⇒ clear not-logged-in error, never an empty list.
- Tier 1 evidence: transcript against deployed staging + pinned `GET /_api/version` commit.

## Status
- [x] `/api/reddit/sub/:name` + `/api/reddit/search` routes, gated readKinds `sub`/`search`
      (prior session, 6779db8).
- [x] `reddit:read` ingredient + label; capability statement amended (6779db8).
- [x] Both-way confinement tests; scopes listing test (6779db8).
- [x] THIS SESSION — defect fix: `search` with `sub` posted `restrict_sr=1&subreddit=<name>` to
      ROOT `/search.json`, which has no `subreddit` param — the restriction silently no-oped and
      callers got site-wide results labeled sub-restricted. Now: sub given ⇒ `/r/<sub>/search.json?restrict_sr=1`.
- [x] THIS SESSION — handler route-table comment lists the two new routes (file convention).
- [x] THIS SESSION — tests: sub-restricted search hits the `/r/<sub>/search.json` contract
      (marker child served only when `restrict_sr=1` is on the wire); root search carries NO
      rate-limit headers upstream ⇒ none fabricated downstream; wire-level header pass-through.
- [x] `deno check server/main.ts` clean.
- [x] `deno test --allow-net --allow-read --allow-write --allow-env` green (147 at c9e6359;
      208 at the merge tip 22a3adc — staging's suite included).
- [x] Deploy (local daemon — no staging daemon token exists on this box; #185 precedent) +
      HTTP transcript: version pin, scopes, capabilities, cross-denials, jar-less 409.
- [x] PR body per template; swap `ready`→`in-review` on PR open.
- [x] Post-PR: staging had moved → merged origin/staging in (22a3adc, adjacent-insertion
      conflicts kept both; no rebase — the push broker cannot force, LESSONS 2026-08-29).

## Operator-run remainder (not collectable from this box)
The live "fresh reddit jar ⇒ real posts" leg needs a node whose egress Reddit serves (zed's IP is
403-blocked on www.reddit.com/.json — verified 2026-09-07) plus a real logged-in jar. Neither
exists here: no reddit credentials/jar snapshot on the box, and pod.dstack.soc1024.com is
operator-credentialed by design. Exact commands go in the PR.
