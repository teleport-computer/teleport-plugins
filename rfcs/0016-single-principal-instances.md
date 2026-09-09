# RFC 0016: Apps are single-principal instances — solo, guest, peer

**Status**: Draft (descriptive of what already runs; §5 is the unbuilt part)

## Summary
Every app on this host has **exactly one principal** — the person whose data it holds and on
whose authority it acts. None of them is multi-user in the way a SaaS app is multi-user, and the
ones that involve a second person do it by *minting that person a scoped capability into the
principal's instance*, not by giving them an account alongside. "Multi-tenant" has never
described this system.

That single claim reorganises everything else: sharing is delegation, not user management;
peer-to-peer is many single-principal instances talking, not many principals in one instance; and
the host is a substrate role rather than a party. This RFC states the shape, shows it is already
the shape (§2), and names the one measured gap between what runs and the peer-to-peer SDK this
is obviously reaching for (§5).

## 1. The claim

**An instance has one principal.** A *principal* is the subject (RFC 0015) whose data the
instance holds and whose credentials it replays. It is the answer to "whose Amazon cart is in
here". Not "who is logged in" — several people may hold capabilities into an instance — but
whose authority the instance is exercising.

Three stages, in the order apps here actually grow:

- **Solo.** The instance holds the principal's data and the principal uses it. No second party.
- **Guest.** The principal mints a scoped, revocable capability to a named other, who uses it
  *against the principal's instance*. The guest brings no data and runs no instance. All the
  attenuation machinery (RFC 0003) and the approver/step-up path (RFC 0005) is this stage.
- **Peer.** Two instances, each with its own principal and its own data, exchange under mutual
  attestation. Neither is a guest of the other; both are principals at home.

The stages are cumulative and an app can stop at any of them. Most stop at solo.

## 2. This is already the shape

From `listing.ts`, every listed app's own capability statement, classified by who it is written
for:

- **solo (7)**: `otterscope`, `timeline-peek`, `reddit-karma`, `feedling-web`, `zai-usage`,
  `twitter-debug`, `demo-app` — all of the form "reads *your* X under a scoped, revocable read
  token".
- **guest (2)**: `cart-share` — "lets a **friend** read your Amazon cart to suggest organic
  substitutions under a scoped, substitute-only capability"; `passbook` — "mints scoped,
  revocable, shareable passes (read-only)… renders a pass card for a **recipient**".
- **peer (1 app, 4 instances)**: `tee-negotiator` is the only app deployed as a family —
  v2/v3/v4/v5 — and its env is `PLAYER_NAME`, `PEER_NAME`, `BRAIN_TOKEN`. Four instances, each
  with an identity and a counterparty. That is not one app with four users.

Nothing here was designed against this RFC; the RFC is reading it back off what got built.

## 3. What follows

**Sharing is delegation, not user management.** There is no user table, and there should not be
one. A second person appears in an instance as a *capability* — minted, attenuated, revocable,
and visible on the approve screen — which is precisely the object RFC 0003 defines. The guest
stage is the delegation continuum applied within one host.

**"Multi-tenant" was always the wrong frame.** The isolation the substrate provides (gVisor,
per-app networks, per-app broker sockets) separates **apps** from each other. It has nothing to
do with separating people, because there are not several people per app to separate. People are
separated by capability scope in the credential core — a different mechanism at a different
layer (RFC 0015 §3, dstack-webhost#121).

**The host is not a party.** The host owner chooses which apps run, provides isolation and holds
the quote. He is not on either side of a delegation. In practice he is also the principal of
nearly every instance here, which is why "host vs user" reads as a distinction without a
difference today — and why the vocabulary must not build a landlord/tenant split into its
foundations.

**Attestation is what makes a guest's position tolerable.** A guest hands nothing over; they
receive. What they must evaluate is whether the instance holding the principal's data will
misuse the capability they were given — and symmetrically, the principal must evaluate the app
before putting data in. Both evaluations are "read the code, check it is what is running". This
is the same argument RFC 0015 §4 makes about possession vs verifiability, seen from the guest's
side.

## 4. Naming

Add to RFC 0015's table:

| word | meaning |
|---|---|
| **instance** | one running app with one principal. `tee-negotiator-v4` is an instance; `tee-negotiator` is an app. |
| **principal** | the subject whose data an instance holds and on whose authority it acts. |
| **guest** | a subject holding a capability into someone else's instance. Brings no data, runs no instance. |
| **peer** | another instance, with its own principal, that this instance exchanges with. |

`tee-negotiator-v2…v5` are four *instances* of one *app*, which is why numbering them as
separate projects has felt awkward: the daemon has no concept of an instance, only of a project.
That is a substrate gap, not a naming accident (see §5).

## 5. The gap between guest and peer, which is already measured

Guest works today. Peer does not generalise, and the reason is specific rather than vague:

**Delegations do not survive crossing an instance boundary — because of what they are addressed
to, not because of how they are carried.** The tenant-exit experiment (2026-08-14) moved a
subject to a new host with only their keys and found that *data survives and grants do not*.
The mechanism is exact:

- `ucan.ts` requires `aud` to be a bare `did:key` — a grant names a KEY.
- `deploy.py` derives an app's key from `GetKey("/tee-daemon/projects/<name>")` — i.e. from the
  NODE's KMS root plus the project name.

So the audience is `did:key(app_pubkey)` where `app_pubkey = f(node KMS root, project name)`.
Nothing about the delegation FORMAT is node-local; the audience VALUE is. Move the app and it
derives a different key at the same path, so every grant addressed to the old one is scrap.

**A delegation between a subject and an app need not name a node at all.** The grant is about
which code may act on the subject's data; the node is an implementation detail of where that code
happens to be running this week. Address the grant to the app's **code identity** — the
measurement RFC 0027's binding quote already produces — and portability stops being machinery to
build and becomes the absence of a mistake.

The one thing that must come with it: a code identity is not a secret, so the grant cannot be
authenticated by key possession alone. The holder must PROVE it is running that code. That is
exactly what the per-app binding quote does (`app_pubkey` bound to `tree_hash` in a TDX quote),
so the exercise path becomes:

1. `aud` names a code identity (or, per td-0024's `allowedCodeIdentities`, a SET of them — which
   is what keeps upgrades from invalidating every outstanding grant).
2. The instance presents a binding quote proving `app_pubkey ↔ tree_hash` on a real TEE.
3. The verifier checks the quote, checks the measurement is admitted by `aud`, and treats the
   presented pubkey as this instance's ephemeral session key.

The key becomes per-node and disposable. The grant becomes per-code and portable. Every piece
exists already — `ucan.ts` for the envelope, RFC 0027 for the binding quote, td-0024 for the
admission set; what is missing is that they have never been wired together in that order.

**This is what makes node owners replaceable.** Solid commoditises hosting providers by letting
the subject carry their data away. That option is not available to us: a live cookie jar cannot
be carried, which is the reason this system exists. Binding grants to code rather than to hosts
gets the same property by the other route — the host was never named, so leaving costs nothing
and a host owner competes on price, uptime and jurisdiction rather than on lock-in. It is the
stronger version of the argument precisely in the case where possession is impossible.

Second, smaller gap: **the substrate has no concept of an instance.** One app deployed four
times is four unrelated projects, sharing no identity, no discovery and no way to enumerate
peers. A peer SDK needs "the other instances of this app" to be a first-class question, which
today is answerable only by reading `PEER_NAME` out of someone's env.

Third: the locator (RFC 0013) already solves *finding* a moved principal — signed HOME pointer,
MOVED tombstone, one-hop follow. It is built for the migration case and is exactly the
primitive peer discovery would want. It is not wired to anything peer-shaped.

## 6. Not proposed

Multi-principal instances. If two people's data belongs in one place, that is a **data room**
(RFC 0006) with an admission policy, not an app with two owners — and RFC 0006 already handles
it as cross-operator federation rather than as shared tenancy.

A user table, accounts, or roles. The capability is the account.

## Acceptance

1. `docs/architecture.md` states the one-principal claim and the solo/guest/peer stages, with
   `cart-share` and `tee-negotiator` named as the worked examples of stages 2 and 3.
2. `listing.ts` capability statements are readable as one of the three stages; anything that is
   not gets its statement rewritten, not its behaviour changed.
3. The two gaps in §5 are filed as issues against the repos that own them — self-contained
   delegation here, instance identity in dstack-webhost.
4. RFC 0015's vocabulary table gains the four words in §4.
