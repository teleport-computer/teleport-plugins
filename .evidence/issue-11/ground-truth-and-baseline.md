# Issue #11 — ground truth, baseline, and what is blocked

## BEFORE (staging, commit 1d57acb, stub fetchItem)
`GET /oauth3/api/youtube/items/jNQXAC9IVRw` (scoped token):
```json
{"plugin":"youtube","data":{"id":"jNQXAC9IVRw","url":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}}
```
HTTP 200 — the stub pair, no title/channel (this is the bug).

## Ground truth — the exact InnerTube player response the new code parses
`POST https://www.youtube.com/youtubei/v1/player` `{"context":{"client":{"clientName":"MWEB","clientVersion":"2.20240726.01.00"}},"videoId":"jNQXAC9IVRw"}` (from the worker box, 2026-08-15):
```json
{"playabilityStatus":{"status":"UNPLAYABLE","reason":"The page needs to be reloaded."},
 "videoDetails":{"videoId":"jNQXAC9IVRw","title":"Me at the zoo","author":"jawed",
   "channelId":"UC4QobU6STFB0P71PMvOGN5A","lengthSeconds":"19","viewCount":"404886875"}}
```
Cross-checked against the public oEmbed endpoint: `{"title":"Me at the zoo","author_name":"jawed",...}`.

## Egress findings (why MWEB + jar auth)
From the staging TEE egress IP (verified live, 2026-08-15, three deploys):
- `/watch` HTML page → `ytInitialPlayerResponse.playabilityStatus = "Sign in to confirm you're not a bot"` (commit c6c7510)
- InnerTube WEB client → same bot-wall (commit 47f75fc)
- InnerTube MWEB client unauthenticated → same bot-wall (commit f03f0a6)
- InnerTube bogus id → real per-id answer (`Video unavailable`) — the endpoint IS reachable; the wall gates unauthenticated content resolution.
The repo's own live-verified precedent (#144 `liked()`) passes this wall with jar-derived
SAPISIDHASH Authorization; fetchItem now sends the same auth (commit 6b57609). The staged
jar is present (31 cookies) but rotted (`logged_in=0` since ~07-19, cf. #132/#136) — its
SAPISID does not authenticate, hence the honest 502 in tier1-transcript.txt.

## Remaining operator step
Seed a logged-in `.youtube.com` jar for the swarm subject (re-sync via the extension), then
re-run: `GET /oauth3/api/youtube/items` → first id → `GET /oauth3/api/youtube/items/<id>`
should return title+channel (criterion 1 live check; criterion 2 is already verified live).

2026-08-18 update (rebase): the snapshot at `~/.paseo-secrets/jars/youtube.com.json` (2026-08-14,
317 cookies / 31 distinct, full SAPISID/`__Secure-3PSID`/LOGIN_INFO set) was seeded to staging
and is ALSO logged out — replayed from the worker box (not the TEE), the history page answers
`logged_in = 0`. A fresh re-sync from a real logged-in browser session is required.
