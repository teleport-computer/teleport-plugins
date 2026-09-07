# Session keepalive

Status: proposed v1 design for issue #136. This document specifies the next
implementation story; it does not change the server or extension.

## Design decisions

### Site set, cadence, and scheduling

The keepalive worker applies only to plugins that opt into a browser keepalive
and have a site-specific entry URL. It must not infer a site or URL from a
cookie domain. The first implementation is deliberately one plugin: YouTube,
at one scheduled cadence of every four hours. The cadence is long enough to
refresh sessions that rotate within hours without turning the browser pool into
a polling client.

There is one independent schedule per `(subject, plugin, account)` vault jar.
The scheduler enumerates the vault's `allJars()` records, so two subjects or two
accounts cannot share a schedule or overwrite one another's result. A run has a
lease timeout and at most one in-flight keepalive for a key. A missed or failed
run remains a failure for the next run to observe; it is not converted into a
successful empty result or silently retried in a tight loop.

The site set is an explicit allowlist in the keepalive worker, initially
`youtube` only. Adding another plugin requires its own entry URL, login
predicate, write-back review, and acceptance evidence. Twitter is not part of
v1: its live browser path is useful evidence that an active session can stay
green, but it is not a reason to generalize the first slice.

### Write-back authority and scope

The browser receives exactly the selected jar for exactly one
`(subject, plugin, account)` key. The keepalive operation is a server-owned
maintenance capability, not an app token and not the owner secret. It is
short-lived, plugin-bound, subject-bound, account-bound, and usable only for
the leased browser's target site and for writing that same vault key.

The browser pool's credential broker (RFC 0018 as used by RFC 0028) is the
authority that delivers the jar to the lease. The keepalive worker must not
send a jar through a shared global browser session or hold a reusable bearer
that can read another subject. On release, the pool resets or destroys the
lease before it can serve another key.

The browser returns the post-navigation cookie jar through the broker's
scoped write path. The worker verifies that the result belongs to the same
lease and target, then atomically writes it as the selected account's jar.
It must never derive a different account, select a first match, or fall back to
`owner`. If the browser cannot return a scoped write or the account identity
cannot be preserved, the run fails and the stored jar is unchanged.

### Logged-out detection

The source of truth is the plugin's `loggedIn(jar)` predicate, evaluated on the
returned jar and on the jar before the run. A browser-side page probe is useful
diagnostic evidence but is not the authorization signal: page markup is
site-specific and can change independently of the plugin contract.

If the returned jar fails `loggedIn(jar)`, the worker records a durable
`logged_out` event containing the subject, plugin, account, run time, and reason
without replacing the prior jar with an empty or guessed value. The user-facing
surface for v1 is the existing plugin/session status response showing that the
account needs a one-time extension re-seed. A successful run records the
refreshed timestamp and does not claim success merely because navigation
returned HTTP 200.

The extension remains the re-seed authority. It can only copy the session that
Chrome currently holds with `chrome.cookies.getAll`; it cannot renew that
session. Its existing cookie-change and 30-minute background resync therefore
remain useful for initial seeding and explicit recovery, but are not the
keepalive mechanism.

### Relation to the leased browser pool (RFC 0028)

Keepalive is a scheduled tenant of the leased browser pool, not a new browser
container or a second shared bridge. A run acquires a bounded lease, injects
only its selected jar, navigates the plugin's configured URL as an ordinary
browser, captures the resulting cookie changes and login signal, then releases
the lease. Queueing and per-lease isolation are pool responsibilities; the
keepalive scheduler must respect their timeout and concurrency limits.

This depends on the pool's per-lease credential scoping and reset semantics.
Until those exist, the current `server/browser.ts` client and its shared
`/session` bridge are not a safe keepalive implementation: concurrent sessions
can clobber one another and a browser-side cookie write would have ambiguous
ownership.

### Relation to #132

Keepalive changes the operational meaning of stale-jar reporting in #132. A
stale timestamp remains useful observability, but it is no longer the primary
user outcome: the system first attempts scheduled repair, then emits an
explicit logged-out/re-seed event when repair cannot establish a logged-in jar.
Issue #132 must not treat a stale jar as healthy merely because a keepalive was
attempted; it should distinguish `refresh_succeeded`, `refresh_failed`, and
`logged_out`, with the last two visible to the user. A future #132 implementation
can consume the durable event rather than re-running browser detection at read
time.

## Recommended v1 follow-up story

Implement YouTube-only keepalive at a four-hour cadence for each
`(subject, youtube, account)` jar, using the RFC 0028 leased browser and scoped
credential broker. On success, persist the returned YouTube cookies to the
same vault key and expose the refreshed timestamp. On a failed `loggedIn(jar)`
check or a browser/lease error, persist an explicit status that the extension
must re-seed; preserve the previous jar and propagate operational errors.

Acceptance for that story:

- A staged test creates two subject/account jars and demonstrates that a
  keepalive lease for one cannot read or write the other.
- A successful YouTube lease writes refreshed cookies only to its original
  `(subject, youtube, account)` key and records `refresh_succeeded`.
- A returned jar without the plugin's login cookie records `logged_out`, keeps
  the prior jar, and exposes the extension re-seed signal.
- A lease timeout or broker error is visible as a failed run; it is not reported
  as a successful refresh or replaced by an empty jar.
- The run uses the shared leased pool and its reset path; no dedicated browser
  container or global `/session` state is added.

## Evidence grounding

The extension's current implementation confirms that `chrome.cookies.getAll`
copies cookies from the user's browser and that its `resync` alarm runs every
30 minutes. The server's current `loggedIn(jar)` contract is a cheap plugin
predicate used before reads and by the scheduler, while vault records are
currently enumerated per subject, plugin, and account.

The 2026-07-24 observation motivating this design was specific: a fresh
YouTube static-jar path went logged-out within about four hours, while Twitter's
live browser session stayed green. That observation supports scheduled live
browser execution for the first slice; it does not establish that every site
has the same cadence or that a successful page load proves authentication.
