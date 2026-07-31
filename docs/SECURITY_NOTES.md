# Security notes

Standing record of known dependency advisories and how they relate to what this
code actually does. Reporting a raw vulnerability count is noise; asserting the
advisories are harmless without evidence is worse. This states, per advisory
class, whether the vulnerable path is reachable here and how that was
determined.

Last reviewed **2026-07-31**. Advisories move. Re-run the audit rather than
trusting this document's age.

## The numbers, and which ones matter

```
npm audit --omit=dev   5 packages, 15 distinct advisories, all high, no fix available
npm audit              16 packages, 22 distinct advisories        (adds the test toolchain)
```

Those are two different questions. The first is what a user of this code runs.
The second includes `vitest`, `vite`, `esbuild`, `tsx` and their trees, which
exist only to run `npm test` on a developer's machine and ship in nothing. This
document analyses the first. The dev-only advisories are real but out of scope
for anyone running the demo, and none of them is reachable from a published
artifact because there is no published artifact: this is a repository you clone.

## Resolved

| Advisory | Action |
| :--- | :--- |
| `ethers` (moderate) | Upgraded to `6.17.0` via an `overrides` entry, since `ethers` is a transitive dependency of `@hiero-ledger/sdk` and not directly declarable |
| `ws` (high) — uninitialized memory disclosure, DoS | Resolved by the same upgrade. `ethers` 6.16.0 pulled `ws@8.17.1`, inside the vulnerable `8.0.0 - 8.20.1` range; `ethers` 6.17.0 pulls `ws@8.21.0`, outside it |

`ethers` sits on the key-handling path (`@hiero-ledger/sdk` uses it in
`PrivateKey.cjs`), so the override was verified with more than unit tests: the
full suite, a credential preflight that exercises key derivation, and a **live
testnet paid call** that settled on chain.

## Open, with no upstream fix available

Five packages remain, carrying fifteen distinct advisories between them. All are
transitive through the Hedera stack, and `npm audit` reports **no fix available**
for each: upgrading `@hiero-ledger/sdk` to the current release does not clear
them.

### `@grpc/grpc-js` — 2 advisories

Both concern a **gRPC server**: a malformed request crashing a server, and a
malformed compressed message crashing a client or server.

**Reachable? The package is loaded; the server role is not, and the client role
is not exposed.** The SDK imports it in `lib/channel/NodeChannel.cjs` and
`NodeMirrorChannel.cjs` to talk to Hedera consensus nodes, so it is on the
transaction path. This repository runs no gRPC server: every listener it starts
is a plain `node:http` server bound to loopback, namely the two demo sellers in
`src/seller/gate.ts` and the one-off server in `scripts/smoke.ts`. As a gRPC
client it connects only to Hedera's own consensus nodes, whose addresses come
from the SDK's built-in network map and not from any input this demo accepts.
Adapting this code to accept an attacker-chosen gRPC endpoint would change that
conclusion.

### `protobufjs` — 13 advisories

Arrives twice: under `@grpc/proto-loader` (7.6.5) and under
`@hiero-ledger/proto` (8.x, the version the advisories cover). Reading all
thirteen, they fall into three groups, and none of the three has a trigger here.

| Group | What it needs | Present here? |
| :--- | :--- | :--- |
| Code injection and code-generation gadgets (`GHSA-66ff-xgx4-vchm`, `GHSA-2pr8-phx7-x9h3`, `GHSA-fx83-v9x8-x52w`, `GHSA-75px-5xx7-5xc7`, `GHSA-f38q-mgvj-vph7`) | Generating or loading code from a `.proto` definition an attacker controls | **No.** This repository defines no `.proto` files and loads none at runtime. Hedera's definitions are pre-compiled and shipped inside `@hiero-ledger/proto` |
| Denial of service through unbounded recursion, expansion, or option parsing (`GHSA-685m-2w69-288q`, `GHSA-jggg-4jg4-v7c6`, `GHSA-wcpc-wj8m-hjx6`, `GHSA-jvwf-75h9-cwgg`, `GHSA-j3f2-48v5-ccww`, `GHSA-94rc-8x27-4472`) | Decoding attacker-controlled protobuf or descriptors | **Not from an attacker.** The only protobuf this code decodes comes from Hedera consensus nodes and the facilitator's response to a request it made. A denial of service against a locally-run demo process is also not a meaningful loss |
| Parsing correctness (`GHSA-q6x5-8v7m-xcrf` overlong UTF-8, `GHSA-jfj6-75fj-8934` text-format map prototype) | Attacker-controlled bytes or text-format input reaching the parser | **No.** No text-format protobuf is parsed anywhere in this repository |

### `@hiero-ledger/sdk`, `@hiero-ledger/proto`, `@x402/hedera`

Flagged because they depend on the two packages above, not for defects of their
own. `npm audit` reports zero advisories against each of them directly. They
clear when the upstream advisories clear.

## What this means in practice

The demo is testnet-only by default, runs locally, and its network surface is
loopback-bound HTTP servers plus outbound calls to the public Hedera mirror
node, Hedera consensus nodes, and a facilitator. None of the open advisories
describes a vulnerability an attacker could reach through that surface.

That is an assessment, not a guarantee. It is based on reading the dependency
graph and this repository's usage on the date above. If you are adapting this
code, particularly if you expose a gRPC server, accept an attacker-chosen gRPC
endpoint, or compile `.proto` files from untrusted input, re-do the analysis for
your own usage rather than inheriting this conclusion.

## The patched dependency

`patches/@hiero-did-sdk+hcs+0.2.1.patch` is not a security patch. It applies an
open upstream pull request so the official DID SDK loads at all. It is described
in [DID.md](DID.md), and the diff is four one-line import changes that can be
read in full in under a minute.

## Reproducing this analysis

```bash
npm audit --omit=dev              # what a user of this code actually runs
npm audit                         # adds the test toolchain
npm ls ws protobufjs ethers       # who pulls each one in, and at what version
grep -rl "@grpc/grpc-js" node_modules/@hiero-ledger/sdk/lib   # where it is used
grep -rn "\.proto" src scripts    # confirm nothing here loads a proto definition
```

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
