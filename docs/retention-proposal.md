# Token + audit retention & compression — proposal (#122)

Design doc only; no code change in this PR. Base: `staging` @ `d54aef1`.

Filed 2026-08-13 to unblock "the retention halves of #119 and #120". Two of those halves
shipped while this issue waited, so this doc covers what actually remains:

- **Audit retention + compression: DONE** — #120, PR #147 (merged 2026-08-05). Age 90d +
  count 1000 bounds enforced on every write and at boot (`server/audit.ts`), an owner-only
  `POST /api/audit/prune` size report (`server/handler.ts:761`), and run-collapsing as a
  dashboard view concern (`server/dashboard-page.ts:136`). §1.4 and §4 record how it works.
- **Jar-ownership discovery: DONE server-side** — #170, PR #171 (merged 2026-08-16) added
  `GET /api/jars` (`server/handler.ts:773`) as the durable replacement for mining
  `/api/audit` for `cookies.sync`. The flows scripts have not migrated to it yet (§1.5).
- **Token-store retention: OPEN** — `server/tokens.ts` still never deletes a row;
  `revokedCids` tombstones grow forever. This is the half #119's close comment left blocked
  on this proposal. §2–§3 are the design for it.

## 1. Storage model, growth, and every consumer

### 1.1 The two stores

Both are whole-file JSON rewrites on every mutation (no append, no compaction), persisted
under `DATA_DIR` (`server/main.ts:5`, default `./data`; passed in at
`server/handler.ts:105` and `:108`):

- **Tokens** — `server/tokens.ts`: `tokens: Record<string, Token>` plus
  `revokedCids: Record<string, true>` tombstones, rewritten by `persist()`
  (`server/tokens.ts:52`). `revoke()` (`:134`) and `revokeSubject()` (`:151`) set
  `revokedAt` and add the delegation CID to `revokedCids`; **no code path ever deletes a
  row or a tombstone** (`importTokens()` `:141` only adds). Each `mint()` (`:76`) embeds a
  365-day UCAN delegation (`:84`, `expiresInSec: 365 * 24 * 60 * 60`).
- **Audit** — `server/audit.ts`: array bounded by `RETENTION_MAX_AGE_DAYS = 90` /
  `RETENTION_MAX_ENTRIES = 1000` (`:18`–`:19`), enforced by `applyRetention()` (`:42`) on
  every `audit()` write (`:51`) and self-healing at boot in `initAudit()` (`:26`);
  `pruneAudit()` (`:70`) backs `POST /api/audit/prune`.

### 1.2 Growth

Token rows accumulate from every mint and are never removed:

- Connect approvals — `approveConnect()` revokes the prior live grant for the same
  `(subject, app, plugin)` tuple but *retains its row* "as an audit trail"
  (`server/connect.ts:82`–`:95`).
- Scope-tighten — revokes the broad token, mints a tight one
  (`server/handler.ts:719`–`:740`).
- The flows sweep mints and revokes an ephemeral owner token per plugin per run
  (`paseo-batch/flows/morning-report.py` `revoke(tok)  # ephemeral — don't pollute the
  token dashboard`; `probe-flows.py:112`) — a steady drip of one dead row per probe.
- Export-confirm revokes every grant of the migrated subject
  (`server/handler.ts:651`) — one bulk dead-row batch per migration.

At filing, staging held 1332+ token rows (~140 revoked). The audit store measured
5000 entries ≈ 905 KB before the #147 boot prune cut it to 1000 ≈ 177 KB
(`.evidence/issue-120/flow.md`) — the same order as the "~800 KB" the issue cites.
Re-count attempted 2026-08-27 from the worker box: the staging oauth3 node refused
connections (3×, empty reply), so today's live row count is unverified here.

Because each write is a whole-file `JSON.stringify`, cost per mint/revoke grows with
total row count, not with live grants.

### 1.3 Consumers of the token store — and what a prune could break

| Consumer | Anchor | Effect of deleting a revoked row |
|---|---|---|
| Read gate `verify()` / `verifyCap()` | `server/tokens.ts:103`, `:129` | **None** — an unknown token is rejected exactly like a revoked one (`return t && … !t.revokedAt …`). Only live rows matter. |
| `verifiedCaps()` delegation check | `server/tokens.ts:109` | **None** — reached only through `verify()`; a row gone means the bearer string is dead. Tombstones (`revokedCids`) are the layer that must outlive rows: see §3. |
| `POST /api/introspect` | `server/handler.ts:707` | None — filters `!revokedAt` itself. |
| `POST /api/tokens/:t/tighten` | `server/handler.ts:719` | None — requires a non-revoked old token; a pruned row yields the same 404 "not found or already revoked". |
| `approveConnect()` reconnect revoke | `server/connect.ts:86` | None — guards `!prior.revokedAt`; it only revokes live grants. |
| `GET /api/tokens` (dashboard) | `server/handler.ts:713` | Thins the revoked history the dashboard can show. The record survives in the audit trail (`token.mint` `:700`, `token.revoke` `:747`), bounded by audit retention. |
| `GET /api/promote` grant association | `server/handler.ts:820` | The per-subject grants Set includes revoked rows; pruning old revoked rows narrows which stale proposals a subject sees. Proposals re-form from fresh gate events, so this is cosmetic. |
| `POST /api/export` migration bundle | `server/handler.ts:599` | A migration would no longer carry the subject's revoked grants. Nothing on the import side distinguishes them for enforcement (`importTokens()` `server/tokens.ts:141` restores rows but does not rebuild `revokedCids`). |
| Step-up first-use ledger | `server/stepup.ts:128` | Separate store keyed on the token's 16-char prefix; orphaned entries for pruned rows are unreachable (the token is dead) and harmless. |

No consumer requires a *revoked* row to exist. Every enforcement path treats "row absent"
and "row revoked" identically.

### 1.4 Consumers of the audit store

| Consumer | Anchor | Notes |
|---|---|---|
| `GET /api/audit` → dashboard Activity | `server/handler.ts:752`; fetch at `server/dashboard-page.ts:213` | Collapses consecutive identical events into one `×N · last <dur>` row at render (`server/dashboard-page.ts:136`, `:146`); expand reveals individuals (`:182`). |
| `GET /api/promote` (promoter corpus) | `server/handler.ts:818` | `proposeIngredients(auditLog())` — the 1000-entry ring is the promoter's only corpus; a high-churn action starves it (652 of 1000 were `stepup.challenged` before #120, per `paseo-batch/flows/capacity.py:49`). |
| ctxauth demo | `server/handler.ts:1463`, `:1471` | Demo-local: seeds three `gate` events, then reads them back through the promoter. |
| `POST /api/audit/prune` | `server/handler.ts:761` | Owner-only size report; idempotent. |
| **Flows-loop owner-discovery (outside this repo)** | `paseo-batch/flows/probe-flows.py:44`–`:58`; `capacity.py:64`–`:76` | §1.5. |

### 1.5 The discovery constraint

The issue's constraint: the flows self-improving loop's owner-discovery reads
`GET /api/audit` as owner and takes the most recent `cookies.sync` per plugin whose
subject starts with `u-` (`probe-flows.py` `audit_subject_for()`; same logic in
`capacity.py` `subj_for()`). Verified 2026-08-27: **both still do** — no `/api/jars` call
in either script.

A bounded audit store cannot guarantee that entry survives: COUNT eviction (1000) can age
out a plugin's only `cookies.sync` while its jar is still live — exactly the
2026-08-16 "no z.ai jar synced" regression, after which `capacity.py` added its own
durable `subjects.json` index (`capacity.py:47`–`:53`).

The structural fix already shipped: `GET /api/jars` (`server/handler.ts:773`, backed by
`allJarStatuses()` `server/vault.ts:172`) returns every current `(subject, plugin,
account)` pair with `updatedAt` straight from the vault — the durable answer the ring
buffer can never give. Migrating the flows scripts to it is a one-repo follow-up outside
this repo (paseo-batch), not a server change.

## 2. Retention options

1. **Age-based prune of all rows** (delete any token row older than N days).
   Smallest diff, but it deletes *live* grants an app simply hasn't used lately — a
   working integration starts failing reads with no operator action. Revocation is the
   only sanctioned way a grant dies; silent expiry-by-prune contradicts that.
2. **Count cap** (global, or per `(subject, app, plugin)` — keep newest K).
   A global cap forces eviction of active rows — implicit revocation, which is the exact
   hazard #119's "cap" wording risked. A per-tuple cap duplicates the guarantee
   `approveConnect()` already gives (one live grant per tuple, `server/connect.ts:86`),
   so it bounds nothing new.
3. **Prune-revoked-after-N-days** (delete only rows carrying `revokedAt` older than N;
   tombstones handled separately, §3).
   Touches only already-dead grants; every consumer in §1.3 treats absent and revoked as
   identical, so nothing observable changes except store size. History remains in the
   audit trail (`token.mint`/`token.revoke`), bounded by audit retention.
4. **Tiered keep-recent + summarize-old** (export revoked rows to a cold JSONL before
   deletion).
   Adds a second store and a restore path for data no consumer reads (§1.3) — archaeology
   for humans only. The `connect.ts:82` "retaining their rows as an audit trail" comment
   is already superseded by the actual audit trail.

## 3. Recommended policy

**Option 3: prune revoked token rows 30 days after revocation, on-write.**

- `TOKENS_REVOKED_MAX_AGE_DAYS = 30` beside the audit constants. Thirty days covers the
  "why did my dashboard say revoked last week?" window; the durable record is the audit
  event, not the row.
- **Tombstones outlive rows until delegation expiry.** `revokedCids` entries are deleted
  only when the row they came from is pruned *and* its delegation has expired
  (`createdAt + 365d`, `server/tokens.ts:84`). UCAN verification enforces `exp`
  (`server/ucan.ts:395`–`:397`), so an expired delegation is rejected regardless; the
  tombstone's only job is the window before that. Implementation note: stamp the
  tombstone with the expiry when the row is deleted, since `revokedCids` carries no
  timestamp today.
- **Enforcement point: on-write, mirroring `server/audit.ts`** — an `applyRetention()`
  called from `persist()` (every mint/revoke/import self-bounds, no cron) plus the same
  boot self-heal `initAudit()` has, so a store that outgrew the policy heals on restart.
  This shape is already proven on staging by #147.
- Optional, for parity with #120: an owner-only `POST /api/tokens/prune` reporting
  `{rows, tombstones, bytes}` before/after. Not required by any consumer.

## 4. Audit compression — shipped, and why render-side is the safer shape

The issue's compression ask (collapse consecutive identical events → one row with count +
time range) shipped in #147 as a **render change**: `renderActs()` in
`server/dashboard-page.ts:136` groups consecutive entries with equal `action` + `detail`
into one `×N · last <duration>` row with an expand toggle (`:182`); the stored trail and
the `GET /api/audit` response keep every individual event.

Render-side is the safer choice under the discovery constraint, and stays so:

- **Store compression would save nothing the ring bound doesn't already save** —
  `RETENTION_MAX_ENTRIES = 1000` caps the store; coalescing rows changes the shape of the
  cap, not its existence.
- **It would lose granularity the consumers rank by.** Owner-discovery takes the *most
  recent* `cookies.sync` per `(subject, plugin)`; the promoter clusters per-event
  `gate.allow`s. A compressed row could preserve the newest `ts`, but every individual
  timestamp older than the run's would be gone — for a store whose whole value is
  per-event history.
- The durable answer for discovery was never compression: it is `GET /api/jars` (§1.5),
  which reads the vault, not the trail.

**How the recommended prune preserves the last `cookies.sync` per `(subject, plugin)`:**
the token prune (§3) touches only `$DATA_DIR/tokens.json` — a different store from the
audit trail, so it cannot remove a `cookies.sync` entry. Within the audit store itself,
no prune stronger than the shipped 90d/1000 policy is proposed. The *guarantee* the
constraint wants is not deliverable by any bounded audit store; it is delivered by
`GET /api/jars` (merged) and lands for the flows loop when those scripts migrate — the
one open follow-up this proposal leaves, and it lives in paseo-batch, not here.
