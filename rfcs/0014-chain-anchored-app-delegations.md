# RFC 0014: Chain-anchored app delegations

**Status:** Proposed

## Decision

An app audience is `appauth:<chain>:<lowercase-contract-address>`. The existing `did:key:z...`
audience remains valid for an instance or user key; every other audience form is invalid. A root
grant addressed to an `appauth` identity is therefore addressed to the app's on-chain admission
policy, not to the node currently hosting it.

An instance exercises that grant by presenting an app-binding quote. The quote is signed by the
instance's ephemeral `did:key`, names the app identity and its code measurement, and contains a
single-use nonce and expiry. The verifier asks the chain-backed admission verifier whether that
measurement is currently admitted by the named contract.

## Open questions resolved

1. **Live set or snapshot:** use the live admitted set. The contract is already the public
   governance boundary for upgrades, and a new grant is not silently re-issued on every deployment.
   Operators must revoke an admitted measurement at the contract layer when it should no longer
   exercise grants.
2. **Chains and KMS modes:** the chain name and contract address are part of the audience. This form
   applies only where a chain-anchored admission contract exists. A KMS mode with no such contract
   continues to use a node or instance `did:key`; it does not get a weaker unanchored app
   identifier.
3. **Revocation:** the contract's admitted-measurement set revokes every instance of a measurement,
   while the quote nonce prevents replay of one instance binding. Short token expiry remains the
   per-grant emergency bound. Per-instance revocation is supplied by rejecting its quote or nonce;
   it is not inferred from a node identity.

## Normative exercise path

1. The grant names the AppAuth contract (or equivalent chain-anchored app id).
2. The instance presents a binding quote proving its `app_pubkey` is bound to its
   `tree_hash`/measurement in a TEE quote.
3. The verifier validates the quote signature, checks that the quote names the parent grant's app
   identity, checks that the measurement is admitted by that contract, and rejects a reused quote
   nonce.

The key is per-node and disposable. The grant is per-code and portable. A verifier must not replace
an unavailable admission result with a positive default, and must not accept a quote for a different
app, an unadmitted measurement, or a previously used nonce.

## Limits of this RFC

The repository's quote type is the signed binding envelope and admission-verifier contract; the
platform-specific TDX quote parsing and chain RPC are supplied by the deployment layer. The verifier
is deliberately injected with that admission check so a local test cannot be mistaken for proof that
a live chain or TEE accepted a measurement.
