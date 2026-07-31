# Demo video script

Runtime **4:51**, against the bounty's five minute ceiling.

Generated from `scripts/video/segments.mjs`, which is also what builds the
video, with per-segment timings measured from the rendered audio, so this file and
the video cannot disagree.

```bash
node scripts/video/script.mjs     # regenerate this file
node scripts/video/build.mjs      # build docs/media/demo-video.mp4
```

## Re-recording the narration in your own voice

The rendered video ships with a synthesised narrator (higgsfield elevenlabs voice=b57b22a0). Every visual in it is real, but the voice is not, and for a submission
that trades on credibility a human read is better. Two ways to replace it.

Whole track, against the timings below:

```bash
ffmpeg -i docs/media/demo-video.mp4 -i your-voice.m4a \
  -map 0:v -map 1:a -c:v copy -c:a aac -shortest docs/media/demo-video-vo.mp4
```

Or segment by segment, dropping your own audio into `docs/media/.build/` under
the matching segment id and re-running the build, which reassembles and re-times
around whatever audio it finds.

---

## 0:00 to 0:16 · 01-hook

**On screen.** Slide, hook layout. Heading: "Two payments. One robbery.".

**Narration.**

> Two agents. Same service. Same price. Both paid on chain, in seconds, for a fraction of a cent. Both got back HTTP two hundred. One of them was robbed. Nothing before the payment could tell you which.

---

## 0:16 to 0:33 · 02-gap

**On screen.** Slide, split layout. Heading: "What a paying agent actually knows".

**Narration.**

> Because payment is not proof of delivery. A paying agent can verify who it paid, what it paid, and that the money landed. It cannot verify that it got the thing. So we built the part that was missing, on Hedera.

---

## 0:33 to 1:01 · 02b-what-is-sold

**On screen.** Slide, compare layout. Heading: "What is being bought".

**Narration.**

> So what is being sold here? A snapshot of a Hedera account. Its balance, its token count, at a moment in time. The buyer is an agent that needs the state of an account it does not run. A paid data API. Nothing exotic. And we picked that on purpose, because it is something you can check yourself. In production you buy the answers you cannot look up. That is exactly when this matters.

---

## 1:01 to 1:40 · 03-demo

**On screen.** Real asciinema capture of `npm start`, slowed to fill the narration.

**Narration.**

> One command. The buyer asks, gets a four oh two, and signs a native Hedera transfer it deliberately leaves incomplete. The facilitator co-signs as fee payer, so the buyer pays the price and never the gas. Then the verifier. It asks the seller nothing. It re-derives the answer from the mirror node. Fourteen checks. All pass. Delivered. Second seller. Payment settles. Two hundred. Schema valid. Identity resolves. Balance wrong. Caught. Everything above that line is identical.

---

## 1:40 to 2:17 · 04-why-identity

**On screen.** Slide, compare layout. Heading: "Why it needs identity".

**Narration.**

> Here is why this needs identity. An attestation about a U R L is worthless. The seller just moves. An attestation about a decentralised identifier sticks. These are did hedera identities. The identifier is the public key, so the key an identity must sign with comes out of the identifier itself. Nobody to trust. And that same key is the key of the Hedera account that gets paid. Not because a document says so. Because the ledger says so, and the verifier checks it there.

---

## 2:17 to 2:43 · 05-code

**On screen.** Code panels read off disk at build time: `src/seller/honest.ts` and `src/seller/dishonest.ts`. Caption: A shape check passes that response. Only re-derivation catches it.

**Narration.**

> The code makes that structural, not rhetorical. Both sellers import the same payment gate and differ only in one handler. So identical payment behaviour is a property of the code. And the dishonest one fakes almost nothing. Right account. Real timestamp. Valid schema. Its own truthful identity. It lies about exactly one thing: the number you bought.

---

## 2:43 to 3:14 · 06-repo

**On screen.** Slide, tree layout. Heading: "Where everything lives".

**Narration.**

> The repository is small enough to read in one sitting, and laid out along the argument. Seller is the gate plus two handlers. Buyer is the paying agent and its spend cap. Verifier is the part that matters: re-derive, decide, attest. The decision logic is a pure function with no network in it, which is why it can be tested exhaustively. Three hundred and seventeen tests run in C I on every change.

---

## 3:14 to 3:38 · 07-build

**On screen.** Slide, steps layout. Heading: "Run it yourself".

**Narration.**

> And you can run the whole thing yourself in about five minutes. One funded testnet account from the Hedera portal is the only input. Setup proves the key controls the account before anything signs. Bootstrap provisions the identities and the attestation topic. Then one command runs both sellers, both payments, and both verdicts.

---

## 3:38 to 4:04 · 08-agent

**On screen.** Real asciinema capture of `npm run buy -- --verify`, slowed to fill the narration.

**Narration.**

> One more way in. The buyer is also packaged as an agent skill. The description is the part that matters. It tells an agent when to reach for this, and never to call an HTTP two hundred a success on its own. So the agent pays, and then re-derives the answer itself. Fourteen checks, and a verdict it never took the seller's word for.

---

## 4:04 to 4:33 · 09-verify

**On screen.** Full-frame screenshot: `docs/media/viewer.png`

**Narration.**

> And you do not have to trust us. This page is one static file. It reads the attestation topic straight off the public mirror node, and checks every signature against the key the attester's identifier commits to. Not the key the message carries, which a forger controls. Two sellers, the same number of paid calls each. One delivered every time. The other, not once. And every payment succeeded.

---

## 4:33 to 4:51 · 10-close

**On screen.** Slide, close layout. Heading: "We build the systems that make claims provable.".

**Narration.**

> Payment rails tell you money moved. This tells you whether anyone got what they paid for, and writes it to the same Consensus Service the identities live on, for a fixed fraction of a cent. Eight years of trust infrastructure. Now the agent economy.

---

## Notes for a live take

- The run itself takes about 19 seconds. The video slows the real capture to
  fill the narration. If you present live instead, pause between the two acts
  rather than rushing your delivery.
- Say two things out loud, because they pre-empt the sharpest objections a
  technical judge will raise. First, the verifier shares a process with the buyer
  in this demo and would be an independent party in production. Second, we wrote
  the dishonest seller, so the fair question is whether the check survives a liar
  we did not write.
- Never show `.env` on screen.
- Each take spends about 0.02 testnet HBAR. Retakes are effectively free, but
  transaction ids change every run, so capture links from the take you keep.
- Rehearse once before recording. It confirms the facilitator is reachable and
  warms the mirror node.
