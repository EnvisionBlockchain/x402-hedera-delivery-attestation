# Identity: `did:hedera`, and the patch this repo carries

## What the identities are

Every party in this demo has a `did:hedera` identity issued by the official
[Hiero DID SDK](https://github.com/hiero-ledger/hiero-did-sdk-js). Each one is
an HCS topic; the identity's creation is a signed event on that topic; and
resolution is a read from the public mirror node.

An identifier looks like this:

```
did:hedera:testnet:FUsRseUzYKD8x5qepSUQXR3YZBQpPCDAnvLkp2LZQ7CE_0.0.9857227
                   └──────── base58btc of the root public key ────┘ └ topic ┘
```

That shape is the reason the rest of this repository can be strict about trust.
**The identifier is the key.** Given only a DID string, the key that identity
must sign with is known, with no network call and nobody to trust. The topic is
where to look for the identity's history; it is not the authority on what the
identity's key is.

## Why that matters here

Resolution never has to trust the topic it reads from, and that is the point.

Suppose a DID topic *were* open to anyone. An attacker appends a create event
claiming an established DID but carrying their own key, and a resolver that
believed the message would treat the attacker's signatures as that identity's.
The forgeries would render as verified and the genuine attestations as invalid.
The control would not merely fail, it would invert.

(As it happens these particular topics are not open: `@hiero-did-sdk` sets a DID
topic's admin and submit keys to the publisher's key, so all four here are keyed
to the operator account that paid for provisioning. That was the SDK's choice
rather than ours, it is stricter than this demo needs, and the README says so
under "What is real, and what is not". The shared attestation topic
`0.0.9857228` genuinely has no keys. Either way the reasoning below does not
depend on it.)

Because the identifier commits to the key, that attack is inert. Both readers in
this repository apply the same rule, and both are tested against a correctly
self-signed forgery:

- `src/hedera/did.ts` (`documentMatchesDid`), used by the verifier and by
  `npm run attestations`
- the `VERIFICATION CORE` block in `viewer/index.html` (`readDidEvent`), which
  additionally checks that the create event's envelope signature verifies under
  that key, so the publisher demonstrably held the private half

## Identity and money are the same key

Every account this demo provisions is **ED25519**, and its account key is also
its DID root key. Nothing in the DID document asserts a link to a Hedera
account; there is no `blockchainAccountId` field in the method's document, and a
self-asserted field on a topic anyone can write to would not be worth much.

Instead the link is checkable against the ledger. `accountKeyMatchesDid` reads
the key the mirror node records for the account that received payment and
compares it to the key the DID commits to. Either they are the same key or that
identity does not control that account. The verifier runs this as
`seller_identity_controls_paid_account` and reports "could not ask the mirror
node" separately from "asked, and the answer was no", so the demo never claims
an impersonation it did not establish.

The buyer is the one exception, and `npm run bootstrap` prints it. The operator
account comes from the Hedera portal and may be ECDSA, which cannot be a
`did:hedera` root key. In that case the buyer gets a separate identity-only key,
written to `BUYER_DID_PRIVATE_KEY`. The buyer signs no attestations, so nothing
downstream rests on that key. Start from an ED25519 portal account and the
exception disappears.

## The patch

`@hiero-did-sdk/*` version 0.2.1 **does not load as published**. Its `hcs`
package imports `@hiero-ledger/sdk/lib/client/NodeClient`, a path no Hedera SDK
version exports under either package name (checked across 2.40 through 2.86, by
`require`, by `import`, and through a bundler). The break came from the
namespace migration in
[PR #53](https://github.com/hiero-ledger/hiero-did-sdk-js/pull/53) and is
reported as [issue #65](https://github.com/hiero-ledger/hiero-did-sdk-js/issues/65).
Upstream CI builds from source rather than from the published tarball, so it
shipped green.

[PR #66](https://github.com/hiero-ledger/hiero-did-sdk-js/pull/66) fixes it in a
few lines, and is open. Rather than fork the SDK or reimplement the method, this
repository applies that change through
[`patch-package`](https://www.npmjs.com/package/patch-package):

```
patches/@hiero-did-sdk+hcs+0.2.1.patch
```

`npm ci` replays them automatically through the `postinstall` script, so a fresh
clone works with no manual step. When the fix is released, delete the patches
and bump the dependency; nothing else changes.

We are not the maintainers of this SDK. Envision Blockchain contributed to the
Hedera DID JS work while it lived under the `hashgraph` organisation; it has
since moved to `hiero-ledger` under different maintainership. Carrying an open
upstream fix, and saying so, is the honest position: it keeps this demo on the
registered method rather than on a private imitation of it.

## Resolving these identities yourself

Nothing this repository runs is involved. Any `did:hedera` resolver works, and
so does the mirror node directly:

```bash
# The topic is the segment after the underscore.
curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9857227/messages?limit=25" \
  | python3 -c "import sys,json,base64;[print(base64.b64decode(m['message']).decode()) for m in json.load(sys.stdin)['messages']]"
```

The create event carries `{ message: { timestamp, operation, did, event },
signature }`, where `event` is base64 JSON holding the `DIDOwner` verification
method, and the signature covers exactly `JSON.stringify(message)`.

## What this proves, and what it does not

That an identity controls the account it was paid into, and that it signed what
it signed. Nothing about who controls that identity in the real world. There is
no issuer, no registry, and no revocation here. See the threat model in the
[README](../README.md).
