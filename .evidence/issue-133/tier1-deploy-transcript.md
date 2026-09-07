# Tier 1 — codex quota plugin, deployed staging transcript

- Node: `https://78ffc78c25e0c8a9e64bb3a969ba6f226abae62d-8080.dstack-pha-prod7.phala.network`
- Deployed ref: `1cdd130` (= PR head after rebase onto `staging` @ 2f19209), via `deploy.sh`
  (manifest-preserving redeploy; post-deploy manifest VERIFIED: isolation=container,
  listen.port=8080, env_passthrough intact, env keys intact).
- Run: 2026-08-15. All responses pasted verbatim.

## Version pin

```
GET /oauth3/_api/version
{"service":"oauth3-server","commit":"1cdd130"}
```

## Plugin registered and live

```
GET /oauth3/api/health
{"ready":true,"plugins":["otter","youtube","reddit","nytimes","twitter","google-calendar","amazon","zai","codex","hackernews"]}
```

## Extension sync contract (`tokenSource`, issue #133 acceptance bullet 3)

```
GET /oauth3/api/plugins            (codex entry)
{
 "id": "codex",
 "label": "ChatGPT/Codex (usage)",
 "cookieDomains": [".chatgpt.com"],
 "account": false,
 "tokenSource": {
   "origin": "https://chatgpt.com",
   "localStorage": ["codex_access_token", "access_token"],
   "jarKey": "codex_token"
 },
 "jars": []
}
```

## Quota chokepoint — scope enforcement

```
GET /oauth3/api/codex/quota        (anonymous)
{"error":"unauthorized"}
HTTP 401
```

## Quota unavailable — honest cause, never a zero (acceptance bullet 5)

```
GET /oauth3/api/codex/quota        (owner secret; no codex bearer synced to the jar yet)
{"error":"no jar synced for codex"}
HTTP 409

GET /oauth3/api/unknownplugin/quota   (owner secret)
{"error":"unknown plugin"}
HTTP 404
```

## Local verification (rebase check)

`deno check server/main.ts` green; `deno test --allow-net --allow-read --allow-write --allow-env server/`
→ **178 passed, 0 failed** (was 129/0 on the pre-rebase base; staging's suite grew with #12/#16 work).
Fixture parsing into the report shape is covered by `server/plugins/codex_test.ts` (acceptance bullet 6).

## Rebase addendum (2026-08-16, second drift: staging @ ddc542e)

Auto-merge gate verdict `3c54fb4e843e`: "gate PASSES but the PR is UNKNOWN against `staging` —
rebase it, no new evidence needed." Rebased `staging-oa-133` onto `staging` @ `ddc542e` (#167 —
"replace duplicate connect grants"), **zero conflicts**; this PR's commits replay as
`226ae2a` (code, was `1cdd130`) + the evidence commit.

Why the transcript above still holds for the rebased code:

```
git diff 1cdd130 226ae2a --stat
 server/connect.ts     | 13 ++++++++++++-
 server/stepup_test.ts | 26 ++++++++++++++++++++++++++
```

The delta is exactly base commit #167's own diff — this PR modifies neither file, so every
PR-owned path is byte-identical and the responses pasted above are produced by the same code
bytes. Re-verification of the rebased tree: `deno check server/main.ts` green;
`deno test --allow-net --allow-read --allow-write --allow-env server/` → **179 passed, 0 failed**
(+1 vs the recorded 178: #167's own new stepup test).

No redeploy was performed for this rebase: the shared staging node currently serves another
lane's PR head (`e4869fc` = `staging-oa-55`; its `/api/health` omits `codex`, as expected for a
branch without this PR). The deployed run above remains the pinned point-in-time evidence the
gate accepted; staging integration of the merged commit is the auto-merger's step.

## Rebase addendum (2026-08-16, third drift: staging @ d6ec3bd)

Same verdict class, relabeled `rework` at 04:25:14Z with the comment suppressed (marker
`3c54fb4e843e` dedupes): #168 merged into `staging` (`d6ec3bd`) nine seconds before the gate's
hourly run, so GitHub still reported `mergeable=UNKNOWN` transiently. Rebased onto `d6ec3bd`,
**zero conflicts** — #168 touches `server/app-page.ts`, `server/handler_test.ts`, docs and its
own `.evidence/issue-55/`, all disjoint from this PR's paths. Commits replay as
`78228df` (code, was `226ae2a`) + the evidence commit.

```
git diff 226ae2a 78228df --stat   # exactly #168's own file set
 .evidence/issue-55/…  PLAN.md  docs/app-contract.md  scripts-walk-55.py
 server/app-page.ts    server/handler_test.ts
```

No PR-owned path appears in the delta, so the transcript's responses are again produced by
byte-identical code. Re-verification: `deno check server/main.ts` green;
`deno test --allow-all server/` → **180 passed, 0 failed** (+1 vs the recorded 179: #168's own
new handler test). No redeploy for the same reason as below (shared staging node serving another
lane's PR head); the auto-merger remains the integration step.

## Could NOT verify

Real upstream ChatGPT/Codex quota numbers end-to-end: that requires a real ChatGPT bearer synced
into the jar (no standing codex consent in the token ledger — jars: amazon, google, otter, reddit,
x, youtube only). The no-bearer path is demonstrated honestly above (409 naming the cause); the
upstream contract + parsing is pinned by the committed fixture and test.

## Fourth rebase addendum (2026-08-16, staging @ 919a1c8, #169)

Same verdict class again — `rework` relabeled at 05:25:13Z, comment suppressed (marker
`3c54fb4e843e` dedupes; gate ran while `mergeable` was transiently UNKNOWN after #169 merged).
Rebased onto `staging` @ `919a1c8`, **zero conflicts** — #169 adds the scoped-token introspection
endpoint (`POST /api/introspect`) in `server/handler.ts` + `docs/http-api.md` +
`server/handler_test.ts`; its handler insertions sit in regions disjoint from every codex-owned
line. Commits replay as `ceffab8` (code, was `78228df`) + the evidence commits.

```
git diff 78228df ceffab8 --stat   # exactly #169's own file set, +56 lines
 docs/http-api.md  server/handler.ts  server/handler_test.ts
git diff 78228df ceffab8 -- server/handler.ts | grep -E '^[+-]' | grep -icE 'codex|tokenSource|quota'   # → 0
```

No PR-owned line appears in the delta (the codex import, `configureCodex(env)`, the `tokenSource`
spread in `/api/plugins`, and the quota chokepoint are byte-identical), so this transcript's
responses are produced by identical code bytes. Re-verification: `deno check server/main.ts` green;
`deno test --allow-all server/` → **181 passed, 0 failed** (+1 vs the recorded 180: #169's own
new introspection test). No redeploy, same reason as prior addenda: the shared staging node serves
another lane's PR head; staging integration of the merged commit remains the auto-merger's step.
