# Submission summary

## Short version

**What is sold.** A snapshot of a Hedera account: its balance, its token count,
and the moment those were true. The buyer is an agent that needs the state of an
account it does not run and does not want to run the infrastructure to watch. A
paid data API, of the kind an agent economy buys constantly.

That resource was chosen because it can be independently re-derived from the
public mirror node. It is the reason every delivery verdict in this submission
is checkable by a stranger rather than taken on our word. In production an agent
buys the answers it *cannot* look up, and that is precisely when a delivery
attestation is the only thing between it and the seller's word.

**What is demonstrated.** An agent pays for that snapshot over x402 on Hedera
testnet, and whether the seller actually delivered it is recorded as a signed
attestation on the Hedera Consensus Service. The demo runs the identical flow
against two sellers: one delivers, one takes the payment and returns a
well-formed response containing fabricated values. Both payments settle on chain
for the same amount, both return HTTP 200, and both sellers hold a real
resolvable `did:hedera` identity. Only the attestation layer distinguishes
them.

## What it demonstrates

Payment settling and the purchased resource arriving are different events, and
only the second is what the buyer paid for. Verifying identity, price, and
settlement does not tell you whether delivery happened. This build makes that
concrete and then writes the missing piece to a permanent, publicly readable
Hedera topic.

## How it uses Hedera rails

- **x402 `exact` scheme on `hedera:testnet`**, using a partially-signed native
  `TransferTransaction` with a facilitator co-signing as fee payer. Not
  EIP-3009: Hedera's USDC is an HTS token without that entry point, so the
  native scheme is used. The buyer pays the price and never pays gas.
- **Hedera Consensus Service for identity.** Four `did:hedera` identities, one
  topic each, DID Documents published as topic messages, resolved through the
  mirror node.
- **Hedera Consensus Service for attestation.** Delivery verdicts signed by the
  verifier and published to a shared topic.
- **Mirror node as the independent source of truth.** The purchased resource is
  a point-in-time Hedera balance snapshot, so the verifier re-derives the
  answer rather than trusting the seller. Balance snapshots are immutable, so
  any third party can reproduce a verdict later.

HCS does two distinct jobs here, identity and attestation, which is what makes
this specific to Hedera rather than a generic chain integration.

## On-chain evidence

- Honest payment: `0.0.7162784@1785519971.048955309`
- Dishonest payment: `0.0.7162784@1785519981.555331365`
- Attestation topic: `0.0.9857228`, sequence #32 (delivered) and #33 (not delivered)
- DID topics: `0.0.9857222` (buyer), `0.0.9857223` (honest seller),
  `0.0.9857224` (mock seller), `0.0.9857227` (verifier)

All on Hedera testnet, viewable on HashScan. Links are in the README.

The identities are `did:hedera`, issued with the official
[Hiero DID SDK](https://github.com/hiero-ledger/hiero-did-sdk-js) rather than a
hand-rolled implementation of the method, so any conformant resolver reads them.
The published SDK does not load; the fix from its own open pull request is
applied here through `patch-package` and documented in [DID.md](DID.md).

## Honesty note

The failing seller is a deliberate mock and is labelled as such in its source
file and in the README. It fakes as little as possible: correct account, real
mirror-node snapshot timestamp, valid schema, and its own truthful DID. Only
the purchased values are invented, which is precisely why a shape check passes
it. Everything else in the demo, including all payments, identities, and
attestations, is real on Hedera testnet.

Attestations are signed JSON rather than W3C Verifiable Credentials. The README
documents the mapping to a VC, including the proof suite and canonicalization
that path would use, rather than half-building it.

## Repository

Apache-2.0 licensed, by Envision Blockchain. `git clone`, `npm ci`, then one command:
`HEDERA_ACCOUNT_ID=... HEDERA_PRIVATE_KEY=... npm start`. Provisioning is
automatic and idempotent; no file needs editing.
