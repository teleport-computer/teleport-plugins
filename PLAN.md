# PLAN — #11 youtube adapter: fetchItem is stubbed (returns only {id, url})

Derived from issue #11 `## Acceptance`. Change type: **backend/API** →
**Tier 1** evidence (HTTP transcript on deployed staging + pinned `/_api/version`).

## Acceptance checkboxes
- [ ] `GET /oauth3/api/youtube/items/<videoId>` on staging returns `data` with non-empty
      `title` and `channel` — not the `{ id, url }` stub pair
      → implementation + tests shipped; LIVE read blocked on a seeded jar
        (see .evidence/issue-11/). Stub baseline: HTTP 200 `{id,url}` pair.
- [x] An id YouTube does not resolve makes `fetchItem` throw (handler → 502), not a
      shaped-but-empty object — verified live on staging, re-verified at rebased tip 5ab1a5b:
      `ZZZZZZZZZZZ` → 502 `{"error":"youtube item ZZZZZZZZZZ: This video is unavailable"}`
- [x] `deno check server/main.ts` green (rebased tree)
- [x] `deno test` green — 188 passed post-rebase (169 at PR time + 19 from staging's new commits)

## Implementation surface (against origin/staging)
1. `server/plugins/youtube.ts`
   - `let BASE = ORIGIN` + `configureYoutube({YOUTUBE_BASE})` (amazon_test pattern) so the
     player call is mockable on 127.0.0.1.
   - `fetchItem(jar, id)` — `POST ${BASE}/youtubei/v1/player` (InnerTube, the SAME JSON
     surface `liked()` already uses, #144) with the jar cookie. First attempt used the
     /watch HTML page (`ytInitialPlayerResponse` + brace scanner) — worked from a local
     IP but is bot-walled from the staging TEE egress ("Sign in to confirm you're not a
     bot"), so the HTML path was dropped for the InnerTube path; no fallback chain.
     Contract: `videoDetails.title|author` present → return
     `{id,url,title,channel,channelId,lengthSeconds,viewCount,shortDescription}`;
     absent (unavailable / private / bot-walled) → THROW with the playability reason
     (handler → 502) — never a shaped-but-empty object. UNPLAYABLE-but-detailed videos
     resolve (presence of videoDetails is the signal, not status==OK).
2. `server/plugins/youtube_test.ts` — local 127.0.0.1 InnerTube mock, fixtures trimmed
   from REAL player responses incl. the UNPLAYABLE-but-detailed, ERROR-without-details,
   and bot-wall shapes: real id → real title/channel; bogus → throws; bot-wall → honest
   error; non-JSON → throws.

## Verification flow (issue #11, step order)
- Precondition: youtube jar present for the rig subject — present, but NO logged-in jar exists:
  the staged one rotted (`logged_in=0` since ~07-19) and the 2026-08-14 swarm-store snapshot,
  when seeded and replayed, is logged out too (see .evidence/issue-11/).
- Because the LIST cannot supply an id while the jar is rotted (operator-repairable
  only), the id used for Tier 1 is a real, stable public id (`jNQXAC9IVRw`), ground-truth
  verified. The "id taken from GET /api/youtube/items" step is commented back to the
  issue as the remaining operator step (re-sync a logged-in youtube jar).
