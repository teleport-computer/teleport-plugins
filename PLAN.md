# PLAN — issue #54: youtube parseHistory extracts per-day section headers so items carry a watch-date

Acceptance checkboxes (from the issue):

- [ ] `GET /oauth3/api/youtube/items` on staging returns items carrying `date` as an ISO string,
      with at least two distinct dates from two different day sections — **not met: live
      transcript blocked on staging egress (see the step below); parser verified offline only.**
- [x] Items under a relative header resolve to a real date ("Today" → today's ISO date).
- [x] A section whose header cannot be parsed leaves `date` unset and its items are still
      returned (no drop).

## Steps

- [x] Read the day label off each `itemSectionRenderer` header
      (`header.itemSectionHeaderRenderer.title.runs[0].text`, `simpleText` fallback) in
      `parseHistory`; stamp every item in the section (videos, lockups, shorts) with it.
- [x] `dayDate()`: "Today"/"Yesterday" resolve against now; "Aug 25" is current year unless
      that lands in the future (year-wrap → last year); "July 12, 2025" keeps its year;
      anything else → `undefined` (undated, never dropped).
- [x] `server/plugins/youtube_test.ts`: fixture-based tests for all header kinds, appended
      beside the #144 liked-videos tests (no network).
- [x] `deno check server/main.ts` + `deno test --allow-net --allow-read --allow-write --allow-env`
      green (205 passed).
- [ ] Live Tier-1 transcript on staging — blocked: staging's oauth3 env has no
      `EGRESS_PROXY_URL`, so the history fetch exits the Phala datacenter IP and Google
      serves `logged_in=0` against a jar synced fresh the same day (the IP-replay de-auth
      signature from worker-corpus 2026-07-03). Operator step filed on the issue.
