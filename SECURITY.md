# Security policy

## What this project is

A demonstration built for the Hedera x402 bounty by
[Envision Blockchain](https://envisionblockchain.com). It runs on **Hedera
testnet by default**, moves faucet HBAR, and exists to show a mechanism:
that whether a paid service actually delivered can be verified independently
and recorded permanently.

It is **not production software**. It has not been audited by a third party. Do
not put real value behind it without doing your own review.

## Reporting a vulnerability

Email **daniel.norkin@envisionblockchain.com** with `SECURITY` in the subject.

Please include what you found, how to reproduce it, and what an attacker could
achieve. If it involves a transaction or an attestation, the transaction id or
topic sequence number is the most useful thing you can send.

Expect an acknowledgement within a few business days. This is a demonstration
repository maintained alongside other work, not a product with an on-call
rotation, and the response time reflects that. Please report privately first
and give us a chance to respond before disclosing publicly.

## In scope

- The verification logic: `src/verifier/`, and the signature checking in
  `viewer/index.html`
- The payment gate in `src/seller/gate.ts` and the buyer in `src/buyer/`
- DID construction and resolution in `src/hedera/did.ts`
- Anything that would let an attestation be accepted as genuine when it is not,
  or a paid resource be served without payment

## Out of scope

- **`src/seller/dishonest.ts` returning false data.** It is a deliberate mock
  that takes payment and returns fabricated values, so that the verification
  can be seen catching it. It is labelled as a mock in its source header, at
  startup, in the README, and in `NOTICE`. That it lies is the demonstration,
  not a defect.
- **Anyone being able to append to the attestation topic.** The topic carries
  no submit key by design. See the threat model in the README: the defence is
  that unsigned or wrongly signed entries are rejected on read, not that
  writing is restricted.
- Third-party services this depends on but does not operate: the Hedera mirror
  node, HashScan, and the Blocky402 facilitator.
- Dependency advisories already assessed in
  [docs/SECURITY_NOTES.md](docs/SECURITY_NOTES.md). New information about
  reachability is welcome; a fresh `npm audit` listing is not.

## Handling of keys and funds

The demo provisions testnet accounts and writes their keys to a local `.env`,
which is gitignored and must never be committed. `npm run setup` prints public
key material only. `HEDERA_NETWORK=mainnet` is supported but spends real funds;
the buyer refuses to sign above `MAX_SPEND_HBAR`, and that cap is the only
limit on what an arbitrary endpoint can charge.
