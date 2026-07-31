---
name: x402-hedera-buyer
description: Buy from an x402-gated service on Hedera and independently verify that what came back is actually what was paid for. Use when an HTTP endpoint returns 402 Payment Required with a hedera payment scheme on testnet or mainnet, when asked to pay for an API call on Hedera, or when asked whether a paid call actually delivered.
---

# Buying over x402 on Hedera, and checking you got what you paid for

This skill drives a CLI in this repository. It is instructions over a command,
not an autonomous agent, and it never signs anything the CLI would not.

It works against any x402-gated endpoint on Hedera. The one this repository
ships sells a **Hedera account snapshot**: an account's balance and token count
at a moment in time, the sort of thing an agent buys when it needs state for an
account it does not run. That resource can be re-derived from the public mirror
node, which is what lets `--verify` reach a verdict instead of trusting the
response.

## Run every command from the repository root

Everything below is an `npm run` script, so it only works from the directory
holding `package.json`, the root of the `x402-hedera-delivery-attestation`
clone. Nothing here is installed globally and there is no hosted service; the
skill is a wrapper over a local checkout.

Confirm the working directory before running anything else:

```bash
test -f package.json && grep -q x402-hedera-delivery-attestation package.json \
  && echo "in the right place" || echo "wrong directory"
```

If that fails, `cd` to the clone first. If the machine has no clone, say so
rather than guessing at a path: the demo cannot run without one, and its
dependencies come from `npm ci`.

The symptom of getting this wrong is `npm error code ENOENT ... Could not read
package.json`, which is npm failing before any of this code runs. It means the
working directory is wrong, not that the setup is broken.

## The thing worth understanding first

Payment settling and delivery are different events. A service can return HTTP
200 with a well-formed body that is not the resource that was purchased. The
payment still succeeds, on chain, irreversibly.

So there are two questions, and answering the first does not answer the second:

1. Did the payment settle? The transaction receipt says so.
2. Was the purchased resource actually delivered? Only independent
   re-derivation can say.

Never report "the call succeeded" on the basis of HTTP 200 alone.

## Setup

The repository needs a `.env`. If commands fail with a missing variable:

```bash
cp .env.example .env
# fill in one funded Hedera testnet account from https://portal.hedera.com/
npm run bootstrap   # provisions the other accounts, DIDs, and the attestation topic
```

Confirm credentials before spending anything:

```bash
npx tsx scripts/check-account.ts
```

This reports whether the configured key actually controls the configured
account, and if not, which account it does control.

## Buying

```bash
npm run buy -- --url <endpoint> --account <hedera-account-id> --verify
```

- `--url` the x402-gated endpoint.
- `--account` the Hedera account to fetch a snapshot of.
- `--verify` re-derive the answer independently and judge delivery. Include
  this whenever the user cares whether they got what they paid for, which is
  almost always.

`--verify` reaches a real delivery verdict only for the Hedera account snapshot
this repository sells, because that is the resource the verifier can re-derive
from the mirror node on its own. Point it at some other x402 endpoint and the
payment still works, but verification stops at the first check it cannot make
and reports NOT DELIVERED. Read that as "not established", not as "the seller
cheated", and say so when reporting it.

Exit code 2 means the payment settled but the resource was not delivered. That
is a meaningful outcome, not a failure to report as an error.

`--url` accepts any endpoint and performs no validation of it. The buyer will
sign a payment to whatever destination account that endpoint advertises in its
402 response. That is correct behaviour for a general x402 client, and it means
**`MAX_SPEND_HBAR` is the only thing limiting what an unknown endpoint can
charge.** Treat an unfamiliar URL as you would an unfamiliar invoice: check the
amount in the 402 before paying, and never raise the cap to make a refused
payment succeed.

## What happens, in order

1. The endpoint is requested without payment and answers `402` with payment
   requirements: amount in HBAR, destination account, and the facilitator's
   fee payer.
2. The seller advertises its `did:hedera` identity in that response, before any
   money moves.
3. A native Hedera `TransferTransaction` is built and partially signed. The
   facilitator adds its signature as fee payer and submits it, so the buyer
   pays the price but never the gas.
4. The request is retried with a `PAYMENT-SIGNATURE` header and the resource is
   returned.
5. With `--verify`, the advertised DID is resolved through the mirror node and
   checked to actually control the account that received the money, then the
   returned values are compared against a snapshot fetched independently.

## Reading delivery attestations

```bash
npm run attestations
```

Reads the shared HCS topic through the public mirror node and verifies each
attestation's signature against the attester's DID. This depends on nothing
this repository runs, which is the point.

## Safety

- `HEDERA_NETWORK` picks the network. Testnet is the default; mainnet works
  only when named explicitly, and spends real HBAR when it is.
- The buyer holds a spending key. `MAX_SPEND_HBAR` in `.env` caps what it
  will sign for, checked against the requirement the client selected and
  before anything is transmitted. If a payment is
  refused for exceeding the cap, report that rather than raising the cap.
- Never print a private key. `check-account` deliberately prints public key
  material only.

## Reporting results

Give the transaction id and its HashScan link, then state delivery separately
from payment. When delivery fails, quote the reason: it names the specific
field that did not match and what the independent source reported instead.
