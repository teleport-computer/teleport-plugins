# RFC 0014: Reads are data — unweld the credential from the API shape

**Status**: Draft (the registry described in §3 is implemented and passing; §5 is not)

## Summary
A plugin is "one per site" today. That is the wrong unit, because a site does not have *an*
API — it has however many API shapes anyone has managed to get working, and they rot at
different rates. Every time one of ours learned a new shape, the shape became a new optional
member of the single `Plugin` interface all ten plugins implement, plus a hand-written route,
plus an attested core deploy. This RFC moves a read out of the interface and into a registry,
so the credential stays singular and refined precisely because it stops absorbing every new
read. It also names the thing that makes variation safe rather than fragmenting: RFC 0001's
validation oracle, applied to competing reads of the same data.

## Problem: build it the obvious way, then look at what you get
The obvious model is one plugin per site. The plugin holds the jar, knows the site, and exposes
the reads that site supports. For one site and one read that is exactly right, and it is why
this design lasted.

Then a site grows a second read shape. YouTube watch history comes from a `/feed`
reconstruction; liked videos come from the InnerTube browse API against playlist `LL`. Same
credential, same trust boundary, different shape. Under one-plugin-per-site, the second shape
is a new method on the plugin. And because `Plugin` is one interface shared by all ten, the
method lands on all ten as `liked?`. Ship that (#144) and the bill is 342 insertions across six
files — `types.ts`, `handler.ts`, `scopes.ts`, `youtube.ts`, and tests — followed by a deploy of
the attested core, to read a different list from a site we already hold the credential for.

Run that loop for a year and the interface is not an abstraction, it is an inventory. Measured
on `origin/staging` at d62cc6c: 42 members, 20 of them optional. Of the nine capability methods,
**six are implemented by exactly one plugin** — `accountId` (twitter), `account` (reddit),
`liked` (youtube), `live` and `fetchFrame` (otter), `substitute` (amazon). The pressure runs
the other way too: `zai` and `codex` are quota-only, so they implement `listItems` and
`fetchItem` for the sole purpose of throwing, because the interface demands them.

This is the observable symptom. The cause is that three things vary independently and are
welded into one file in the attested core:

| | varies how | today |
|---|---|---|
| the **credential** | one jar per (site, account) | `Plugin` — singular, stable, small |
| the **read** | one API shape; many per site, unstable | a member of `Plugin` |
| the **trust rule** | which ingredient gates the read | `scopes.ts` — already data, already fine |

The trust rule was extracted years ago and nobody has complained about it since; `SCOPE_INGREDIENTS`
is a table and adding an entry is a table edit. The read never was. So varying the read forces a
change to the credential's *type*, which forces a core deploy, which puts a one-off API shape
through the release path that should be reserved for changes to authorization itself.

RFC 0012 already made this argument for *whole sites* and shipped: a longtail site is a JSON
manifest, `POST /api/sites` registers one at runtime, no deploy. But its manifest could declare
exactly three read kinds — `items`, `account`, `item` — and `validateManifest` rejected the rest
with `unknown read kind`. A declarative site that grew a fourth shape had to become code.

## The tension this has to resolve
Two things are wanted at once and they look opposed:

1. **Consolidate.** A jar per site, well-studied, simple, refined. Ten of those is a system you
   can reason about; a hundred bespoke credential handlers is not.
2. **Admit variation.** Sites break their APIs. There is more than one valid way to read a site,
   and which one is correct changes without warning.

They only look opposed because the seam is in the wrong place. Consolidation is wanted for the
*credential*; variation is unavoidable in the *read*. Weld them and every new read either
corrupts the credential model or gets refused. Separate them and both hold — the credential
stays small **because** it no longer absorbs read shapes.

## 3. Design: a read is a registration (implemented)
`server/reads.ts`. A named read declares which plugin's jar it replays, which `readKind` the gate
confines it to, a label for the ledger, and how to run:

```ts
export interface NamedRead {
  plugin: string;
  kind: string;
  label: string;
  run(jar: Jar): Promise<unknown>;
}
```

Two ways to register, neither of which touches `Plugin`:

- **Hand-written.** A module-level `registerRead({...})` at the bottom of the plugin file. It runs
  when `registry.ts` imports the module. `youtube:liked` is migrated this way as the proof: it is
  now a module function, `liked?` is gone from `types.ts`, and the existing history↔liked
  cross-denial tests pass unchanged.
- **Declarative.** Any url-safe key in a manifest's `reads` beyond the three the interface carries
  becomes a named read. RFC 0012's three-kind ceiling is gone; for a runtime-registered site this
  is still no deploy at all.

`handler.ts` serves every named read from **one** route, `GET /api/:plugin/:kind`, placed after
the bespoke routes. So the route table stops growing alongside the interface.

Confinement does not move. The route calls the same `gateRead(token, plugin, readKind, bearer)`
chokepoint every other read calls, so a scope ingredient over a registered read is exactly as
enforceable as `reddit:karma` — never hollow. Manifest reads stay pinned to the manifest's
`cookieDomains`, and a scope still cannot grant a read the manifest never declared.

A generic route can hide two mistakes a hand-written one cannot, so both fail at registration
rather than at request time:

- Registering a **reserved** kind (`items`, `account`, `quota`, `feed`, `live`, `frame`,
  `screenshot`, `jar`, …) throws. The generic matcher is last, so such a read would be silently
  shadowed — or, if the order ever changed, would silently shadow.
- Registering a **duplicate** `(plugin, kind)` throws rather than overriding. Two reads answering
  one URL would resolve by import order, which is not a thing anyone should have to know.

## 4. What this deliberately does not do
- **Not** a new trust story. The jar never leaves the attested context; the gate is unchanged.
- **Not** a DSL. A hand-written read is a TypeScript function, as before. Only its *attachment
  point* moved.
- **Not** a migration of the other five single-use methods. `account`, `live`, `fetchFrame`,
  `quota`, `accountId` still sit on the interface. Moving them is mechanical and should happen
  one at a time, each with its route, when someone is already in that file.

## 5. The part that makes variation safe (not implemented)
Removing the cost of adding a read variant raises the obvious objection: now there will be five
half-working YouTube readers and no way to know which is right. That objection is correct, and it
is already answered by a mechanism this repo specified and half-built.

RFC 0001 (adapter reification loop) says a delegated read has two tiers — a browser carrying the
cookie, always correct and expensive; a reified spec, cheap and liable to rot — and that the
browser is the **validation oracle**: diff the spec's output against it, and auto-demote the spec
when the platform changes. Built today: `/capture-trace` captures the real network ops during
browser actuation, and amazon cart-write and `twitter-actions.ts` carry reified ops as evidence.
Not built: the tier registry, the router, and the divergence check. There is no `scoped-fetch`
and no `divergence` anywhere in `server/`.

Applied to named reads, that machinery is exactly the arbitration this RFC needs. Two reads
claiming the same data are not a fork; they are candidates, and the oracle ranks them. The read
that validates serves traffic. When YouTube changes InnerTube, the reified read diverges,
demotes, and the browser variant answers until someone reifies a new one — **and nobody edits the
core**, because a read is a registration and demoting one is a state change, not a deploy.

That is what turns "multiple valid approaches" from a liability into the design. Consolidation
stops being a constraint imposed at authoring time and becomes an outcome: the refined read wins
because it is *measured*, not because the interface forbade the alternatives.

The concrete next step is not the whole loop. It is: give `NamedRead` a `validates?: string`
naming the read it claims to reproduce, and a job that runs both and records agreement. Ranking
and auto-demotion can wait for evidence that two implementations of one read actually exist.

## 6. Relationship to the other RFCs, and a deferral that expired
- **RFC 0012 (declarative sites)** — this extends it. Same loader, same host-pin, ceiling removed.
- **RFC 0001 (reification)** — this supplies the unit that loop was missing. 0001 assumed a
  "flow"; a `NamedRead` is that flow, addressable and registrable.
- **RFC 0008 (unified capability packages)** — the *write* half of the same argument. Its §3 says
  adding a write capability should be "package-local authoring (a scope + a policy + a handler),
  not a core edit", and its §4 defers that to Phase 2 with an explicit trigger: *"Ship only once a
  2nd or 3rd write capability proves the pattern. Do not build the DSL on speculation."*

  That trigger has been met several times over, on the read axis, which nobody was watching.
  `account`, `liked`, `live`, `fetchFrame`, `quota` and `accountId` are six single-implementation
  variants, each of which was a core edit, and every one of them shipped after 0008 was written.
  This RFC un-defers 0008's Phase 2 for reads only, and takes the cheap half: a registry, not a
  DSL. The write half still waits for a second write capability, correctly.

## 7. Trade-offs and an honest why-not
- **A generic route is harder to read than eight specific ones.** You can no longer grep
  `handler.ts` for a URL and find its implementation. Mitigation: `readsOf(plugin)` enumerates
  them and the label is required, so the ledger and the approve page can render what exists. This
  is a real loss of locality traded for the interface no longer growing.
- **Registration order becomes load-bearing at startup.** A read registers when its module is
  imported, so a plugin that is never imported silently has no reads. Mitigation: registration
  lives at the bottom of the plugin file, which `registry.ts` already imports by name; a plugin
  absent from `registry.ts` has no jar either, so it fails loudly at the gate, not quietly here.
- **The interface is not actually smaller yet.** One member moved. Until the other five follow,
  this is a second way of doing the same thing, which is worse than either way alone. This is the
  strongest argument against merging §3 without committing to §4's cleanup.
- **Cheap variants invite slop.** Lowering the cost of a new read means more reads of unknown
  quality. §5 is the answer and §5 is not built. Until it is, the honest state is that this makes
  variants cheap to add and no easier to judge.

## 8. Open questions
- **Should `readKind` and the scope ingredient be the same string?** They are 1:1 in every case
  today (`youtube:liked` → `liked`). Collapsing them would delete `SCOPE_INGREDIENTS`'s `reads`
  array, but forecloses one ingredient granting several reads, which `otter:live-follow`
  (`["live","frame"]`) currently uses.
- **Where does a write register?** RFC 0008 says a package declares intents. A `NamedWrite` with a
  policy function is the symmetric shape, but §6 is right that it should wait for a second write.
- **Do runtime-registered reads need their own attestation record?** A manifest posted to
  `/api/sites` changes what the attested core will do with a jar. Today it is owner-only and
  persisted; whether that belongs in the measurement is unresolved.
