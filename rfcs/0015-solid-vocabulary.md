# RFC 0015: Borrow Solid's vocabulary, keep our mechanism

**Status**: Draft (vocabulary proposal; every mapping below points at code that exists)

## Summary
We have three layers — the person who runs the host, the apps running on it, and the users of
those apps — and no settled words for them. "Tenant" currently means a *container* in
`dstack-webhost` and a *user* in `oauth3-server` (`vault.ts`: "Per-tenant, per-plugin,
per-account cookie jars"). Same word, two layers, one repo apart. Solid has spent years naming
this exact shape and its terms are load-bearing rather than decorative, so this RFC adopts them
where they fit, marks where our architecture is deliberately inverted from theirs, and names
what we have that Solid has no word for because Solid has no equivalent.

The short version: **Solid decouples data from apps by *possession* — your data sits in your
storage and apps visit it. We cannot do that, because a live cookie jar is not a document you
can hold. We substitute *verifiability*: the app holding your credential is bound to a source
hash you can read.** Same goal, different lever, and the vocabulary should make that legible
instead of hiding it.

## 1. What Solid actually defines

From the Solid Protocol spec, not the marketing pages:

- **storage** — "a space of URIs that affords agents controlled access to resources." This is
  the normative term. **"Pod"** is the community word for a storage (a "personal online
  datastore"); it does not appear as a normative definition in the protocol spec.
- **agent** — "a person, social entity, or software identified by a URI; e.g., a WebID denotes
  an agent." Note that an agent may be *software*, not only a person.
- **Solid app** — "an application that reads or writes data from one or more storages."
- **container resource** — "a hierarchical collection of resources that contains other
  resources, including containers."

From Web Access Control: access modes are **Read**, **Write**, **Append**, **Control**
(Control being access to the ACL resource itself). An **Authorization** is "an abstract thing
which is identified by a URI and whose properties are defined in an ACL resource, e.g., access
modes granted to agents."

From Solid-OIDC: a **Client** (typically ephemeral — "most Clients cannot keep secrets"), an
**OpenID Provider** ("may be an identity-as-a-service vendor or a user-controlled OP"), a
**Resource Server**, a **WebID** ("a URI with an HTTP or HTTPS scheme which denotes an Agent"),
and **DPoP**, "a mechanism for sender-constraining OAuth tokens via a proof-of-possession
mechanism on the application level" — a JWT signed by a key the client chose.

## 2. The naming collision, stated plainly

Our "pod" is `pod.dstack.soc1024.com`: **the host CVM apps run on**. Solid's pod is **the user's
data store**. Opposite ends of the same relationship, and `locator.ts` already writes it our way
("After a pod migration, anything still holding the OLD pod URL must be able to find the new
home").

Because the normative Solid term is *storage*, not *pod*, the collision is cheaper to resolve
than it looks: we can adopt **agent**, **storage**, **app** and the WAC access modes without
ever having to fight over "pod". This RFC proposes we simply stop using "pod" as a
specification word — keep it as the informal name of the box, the way "the pod" means the CVM
in conversation — and use **host** in text that has to be precise.

## 3. Proposed vocabulary

| layer | word | definition | what the code calls it today |
|---|---|---|---|
| the operator | **host owner** (informally: the host) | the person who runs the node and chooses which apps run on it | `OWNER_SECRET`, `isOwner()`, `TEE_DAEMON_TOKEN` |
| the node | **host** | the attested CVM serving apps | "pod", `pod.dstack.soc1024.com` |
| the deployed unit | **app** | code the host owner installed, with its own container, source pin and quote | `project` (the dataclass, `/_api/projects`) |
| the delegator | **subject** (informally: user) | the person who signs in and delegates; identified by a did:key | `subject` (`u-…`), `identity.ts` |
| the delegate | **agent** | software acting on a subject's behalf under a scoped token — what the word already means in this stack | swarm workers, `hermes-agent`, `AGENTS.md` |
| the subject's data | **storage** | that subject's jars and records, wherever they live | vault keys `${subject}:${plugin}:${account}`, TinyCloud |

**An app is not an agent and an agent is not an app.** Agents are cross-cutting: one agent
delegates to many apps, and the same jar is read by several. This is the distinction
`dstack-webhost` currently loses by calling containers "tenants" (filed separately).

"Tenant" is not in the table on purpose. It is cloud-infra language for *the party you are
isolating*, which in our stack is ambiguous exactly where we need precision: gVisor isolates
apps, `gateRead` isolates subjects. Use the specific word.

**And we deliberately do NOT adopt Solid's `agent` for the person.** Their definition is "a
person, social entity, **or software** identified by a URI" — software counts. That is harmless
in Solid, where an app is a dumb client fetching documents, and fatal here, where the entire
point is that a person delegates a scoped capability to software acting on their behalf. A word
that covers both parties cannot name either side of the relationship this system exists to
mediate; "the agent delegates to the agent" would be well-formed. It is also already taken: 289
uses across our repos, all meaning an AI worker (`AGENTS.md`, the swarm's lanes, `hermes-agent`).

So `agent` keeps its local meaning — **the delegate** — and the person is the `subject`, which is
what `vault.ts`, `identity.ts` and OIDC's `sub` already call them. The three roles are then the
three parties in one delegation, which is the relationship RFC 0003 is about.

## 4. What we already have, in these terms

| Solid | ours | file |
|---|---|---|
| WebID denotes an agent (person *or software*) | **did:key subject** — the person only; software acting for them is an `agent` holding a scoped token | — "you prove who you are by signing a server-issued challenge with your key… The session subject IS your did:key" | `identity.ts` |
| Solid-OIDC + DPoP proof-of-possession | the same primitive without an issuer: sign a challenge with a key you chose | `identity.ts`, `tokens.ts` |
| a *user-controlled OP* | did:key needs no OP at all — the identifier is the key | `identity.ts` |
| WAC access modes | scope ingredients + `gateRead` readKinds; `maxScope` read/raw; structured caps (`write:event:<id>`, `amazon:cart-substitute`) | `scopes.ts`, `handler.ts` |
| WAC Authorization | a minted scoped token: an agent, an app, a set of reads, revocable | `tokens.ts` |
| a storage you can move between providers | **encrypted export / import bundle**, x25519-sealed to the agent's key | `export.ts`, `migration.ts` |
| — | **locator**: signed HOME pointer per subject DID, MOVED tombstone, 410 + one-hop follow | `locator.ts` |
| — | **attestation**: the running app bound to a source hash a stranger can verify | RFC 0020/0027 (dstack-webhost) |

Two of those rows have no Solid counterpart, and they are the two that carry our thesis.

**The locator is the thing that makes leaving work rather than merely permitted.** Solid says
you may move storage providers; it does not standardise how everything holding your old URL
finds you afterwards. We sign a per-subject record, serve a tombstone with a 410 on the origin,
and follow `movedTo` exactly once.

**Attestation is the substitute for possession.** This is the honest centre of the design. In
Solid the reason you need not trust the host is that the host holds documents you could have
held yourself. We cannot offer that: a cookie jar is a live credential, it must be replayed from
somewhere, and if the agent could hold it there would be no delegation problem to solve. So the
claim we make instead is: *you can read the code that holds your credential, and check that the
code you read is the code that is running.* That is a weaker claim than possession in one way
(you are still trusting a running system) and a stronger one in another (you can inspect what it
does with the credential, which a Solid app's source never had to reveal).

## 5. Consequences worth stating

**An app with no readable source is not merely undocumented — it is outside the model.** Under
possession-based decoupling, an opaque app is survivable: it only ever sees the documents you
hand it. Under verifiability-based decoupling, an opaque app is the *whole* trust hole, because
inspecting it is the only protection on offer. `tee-negotiator-v2` and `v3` are attested, hold
no source, no commit and a tree hash nobody can obtain — an agent deciding whether to delegate
to them has nothing to inspect. This RFC's vocabulary makes that a category error rather than a
loose end.

**"Migration" means two different things and we should stop using one word.** `export.ts` moves
an agent's *storage* (jars) to another host. That is Solid's provider-switch. It does **not**
move delegations: the TinyCloud tenant-exit experiment (2026-08-14) found parents are node-local
and the wire format is not self-contained, so capabilities do not survive the move. An agent who
exits keeps their data and loses their grants. Name it: **storage export** works, **delegation
export** does not exist.

## 6. Not proposed

Adopting Solid's *mechanisms* — LDP containers, RDF resources, ACL documents, WebID profile
dereferencing. Our data is cookie jars and scoped tokens, not linked-data documents; the shapes
do not transfer even where the words do. This RFC borrows the vocabulary and the layering
discipline, nothing else.

Renaming anything in code. `project` stays `project` in `dstack-webhost` — 1124 uses, and it is
the right word for a deployment unit. This is about the words in docs, issues, RFCs and the
public trust surface, where the layer confusion actually costs a reader something.

## Acceptance

1. `docs/architecture.md` states the five terms in §3 and the app/agent distinction, once, near
   the top.
2. The public trust surface (the console, `docs/auth.md`, the approve screen) uses **subject** or
   **user** for people, **app** for apps, and **agent** only for software acting on a subject's
   behalf — with no "tenant".
3. §5's two consequences are each filed as their own issue, so they do not live only in an RFC.
4. `vault.ts`'s "Per-tenant" comment reads "Per-subject", matching both the layer and the key it
   is actually about (`${subject}:${plugin}:${account}`).

## References

- [Solid Protocol](https://solidproject.org/TR/protocol) — storage, agent, Solid app, container resource
- [Web Access Control](https://solidproject.org/TR/wac) — access modes, Authorization, ACL resource
- [Solid-OIDC](https://solidproject.org/TR/oidc) — Client, OP, Resource Server, WebID, DPoP
- [Solid FAQ](https://solidproject.org/faq) — "pod" as the community term for a storage
