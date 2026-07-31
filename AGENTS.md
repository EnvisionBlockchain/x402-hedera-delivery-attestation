# Working in this repository

An agent buys a Hedera account snapshot, its balance and token count at a moment
in time, from a paid API over x402 on Hedera. Whether the seller actually
delivered it is written to Hedera Consensus Service as a signed attestation.

That resource was chosen because it can be re-derived from the public mirror
node, which is what makes every verdict here checkable rather than asserted.
Full explanation in [README.md](README.md).

This file is the portable entry point, read automatically by Codex and other
agents that follow the `AGENTS.md` convention. Claude Code users get the same
content as a skill: see [skills/x402-hedera-buyer/SKILL.md](skills/x402-hedera-buyer/SKILL.md).

## Read this before buying anything

The buying workflow, its flags, and how to report results live in
[skills/x402-hedera-buyer/SKILL.md](skills/x402-hedera-buyer/SKILL.md). Read
that file before running a paid call. It is the authoritative instruction set;
this file only carries the rules that matter even when it has not been read.

## Rules that apply to every session here

**Run commands from the repository root.** Everything is an `npm run` script,
so it only works from the directory holding `package.json`. `npm error code
ENOENT` means the working directory is wrong, not that the setup is broken.

**Payment settling is not delivery.** A service can return HTTP 200 with a
well-formed body that is not the resource that was bought. Never report a paid
call as successful on the basis of the status code. Use `--verify`, which
re-derives the answer from the mirror node, and report its verdict.

**Exit code 2 from `npm run buy` is a real answer, not a crash.** It means the
payment settled and the resource was not delivered. Report it as that finding.
Against an endpoint that is not this repository's snapshot seller, the same exit
code means verification could not be completed, because the verifier only has an
independent oracle for that one resource. Report that as unestablished rather
than as a seller cheating.

**Testnet is the default and mainnet spends real money.** `HEDERA_NETWORK`
selects the network. Do not switch to mainnet unless explicitly asked to. Run
`npm run netcheck` after any network change; it signs nothing.

**Never print a private key.** `npm run setup` deliberately prints public key
material only. Do not echo `.env`, and do not paste key material into commit
messages, issues, or logs.

**Do not raise the spend cap to make a payment succeed.** If a payment is
refused for exceeding `MAX_SPEND_HBAR`, report the refusal.

The reason: `npm run buy -- --url` validates nothing about the endpoint, and the
buyer signs a payment to whatever account that endpoint asks to be paid. The
cap is the only limit on what an arbitrary or compromised endpoint can take,
and the only thing between a retry loop and an empty account. Raising it to
clear a refusal removes the sole control at exactly the moment it fired.

**`src/seller/dishonest.ts` is a deliberate mock.** It takes payment and
returns fabricated values so the verification can be seen catching it. It is
labelled as a mock in its source header, at startup, in the README, and in
NOTICE. Do not deploy it, and do not "fix" it: the demo depends on it lying.

## Verifying your work

```bash
npm test          # unit suite, no credentials; the gate tests do reach the facilitator
npm run typecheck # strict TypeScript
npm run netcheck  # config coherence, signs nothing
```

`npm test` and `npm run typecheck` both run in CI on every change. Do not
commit with either failing.
