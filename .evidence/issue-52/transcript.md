# Tier 1 evidence — issue #52: failed reads now leave a read.outcome row

Deployed staging: branch `staging-oa-52`, commit `af843df`.

```
$ curl -s $B/oauth3/_api/version
{"service":"oauth3-server","commit":"af843df"}
```

Signed in as the rig identity u-swarm (subject `u-eaf13541f186c7c5f466dc04e2e5da4b` — the
userKey in ~/.paseo-secrets/swarm-userkey hashes to this subject; the subject written in the
older specs, u-cc7f19ff9b44522c2bf725b7d02d15de, belongs to a prior key). Scoped tokens minted
through the real handshake: POST /api/connect (app demo-app, scope read) → approve with the
u-swarm session → token from GET /api/connect/:id.

## READ 1 — ok (200), live reddit jar

```
$ curl -s -w '%{http_code}' "$B/oauth3/api/reddit/items?page_size=3" -H "Authorization: Bearer <reddit token>"
{"plugin": "reddit", "items_returned": 51, "first": {"id": "t3_127ayvk", "title": "What are some of your favourite comedy films from the 1990\u2019s"}}
200
```

## READ 2 — no-jar (409): jar lookup resolves nothing

Every demo-app-listed plugin has a live jar for u-swarm, so the no-jar path is exercised via
a non-existent `?account=` — `getJar(subject, plugin, account)` is an exact-key lookup, so
this hits the same `readJar !ok → 409 "no jar synced"` branch as a jar-less plugin, without
deleting anything from the shared staging vault.

```
$ curl -s -w '%{http_code}' "$B/oauth3/api/reddit/items?account=no-such-account" -H "Authorization: Bearer <reddit token>"
{"error":"no jar synced for reddit"}
409
```

## READ 3 — error (502): a real, pre-existing read failure

nytimes server-side replay is blocked by NYT (datadome 403) — the plugin throws; before this
change that 502 left no audit row at all.

```
$ curl -s -w '%{http_code}' "$B/oauth3/api/nytimes/items" -H "Authorization: Bearer <nytimes token>"
{"error":"NYT blocks server-side replay (datadome 403) — nytimes is a BROWSER-PATH plugin; run it via the browser (Teleport Computer), not the frozen path"}
502
```

## GET /oauth3/api/audit (owner) — exactly one outcome row per read above

```
{"action": "read.outcome", "plugin": "nytimes", "readKind": "items", "outcome": "error", "message": "NYT blocks server-side replay (datadome 403) \u2014 nytimes is a BROWSER-PATH plugin; run it via the browser (Teleport Computer), not the frozen path", "by": "demo-app"}
{"action": "gate", "plugin": "nytimes", "readKind": "items", "decision": "allow", "by": "demo-app"}
{"action": "read.outcome", "plugin": "reddit", "readKind": "items", "outcome": "no-jar", "by": "demo-app"}
{"action": "gate", "plugin": "reddit", "readKind": "items", "decision": "allow", "by": "demo-app"}
{"action": "read", "plugin": "reddit", "item": "list", "count": 51, "by": "demo-app"}
{"action": "gate", "plugin": "reddit", "readKind": "items", "decision": "allow", "by": "demo-app"}
```

READ 1's outcome row is the `read` row (`count` now included); READ 2 → `read.outcome
no-jar`; READ 3 → `read.outcome error` with the thrown message. Each read also keeps its
`gate` allow row, unchanged. The fourth outcome, `not-logged-in` (jar present but
`loggedIn()` false → 409), is asserted in `server/handler_test.ts` ("failed reads leave
exactly one read.outcome row (#52)") alongside the other three.

test log: `~/paseo-batch/out/oa-52/test.log` — 203 passed, 0 failed.
