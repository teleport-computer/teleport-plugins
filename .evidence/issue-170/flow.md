# #170 — GET /api/jars (vault directory) — staging evidence

Change class: backend/API, no UI surface → **Tier 1** per CONSTITUTION.md's tier table.
The issue's acceptance asks for a specific staging demonstration; delivered here in full.

## Acceptance vs evidence

1. **Owner-only, 401 without the owner secret, exactly like /api/audit** —
   `GET /oauth3/api/jars` with no auth → `{"error":"owner only"}` HTTP 401 (transcript).
   With the owner secret → HTTP 200.
2. **Every (subject, plugin) pair with `updatedAt` and `count`; no cookie names/values** —
   live response (transcript) carries only `subject, plugin, account, updatedAt, count`.
   Handler test additionally asserts the serialized response contains no cookie name ("session")
   or value ("x").
3. **Reflects the vault, not a log** —
   - Handler test: jar whose `cookies.sync` never entered the audit log is still listed;
     after `deleteJar()` the pair disappears; directory pairs ≡ `allJars()` pairs (asserted).
   - STAGING (the issue's exact scenario, live): audit ring buffer is at its 1000-entry cap
     (601 × `stepup.challenged`) and contains **0** `cookies.sync` for plugin `zai` — yet
     `/api/jars` lists the zai jars (`owner`, `u-eaf13541…`, synced ~2026-08-10) still in the
     vault. Audit-mining says "not synced"; the vault says synced. Directory wins.
4. **Equivalence with allJars() asserted in a handler test** —
   `server/handler_test.ts`: "GET /api/jars is the vault directory — same pairs as allJars()…".

## Not verifiable on staging
`DELETE`-then-disappear was verified only in-process (handler test): deleting a real jar on the
shared staging vault would destroy live operator state. Same code path (`deleteJar` → store).

Pinned: `GET /oauth3/_api/version` → `{"service":"oauth3-server","commit":"d101447"}` (this PR).
