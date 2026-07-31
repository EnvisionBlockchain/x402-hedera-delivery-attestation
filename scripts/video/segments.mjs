/**
 * The demo video, defined declaratively.
 *
 * Every segment is either a rendered slide (real content, real file excerpts) or
 * a real asciinema capture: `npm start` for the demo, and the buyer skill's own
 * `npm run buy` for the agent segment. Nothing here is synthetic footage of
 * something that did not happen.
 *
 * Pacing rules learned the hard way: open on tension, not exposition. Be running
 * code inside forty seconds. Short sentences, because a synthesised voice loses
 * the thread on long clauses and the cut points get mushy.
 *
 * Visual language follows envisionblockchain.com: near-black ground, Source Serif
 * display, IBM Plex for sans and mono, the cyan-to-lavender iridescent gradient
 * used sparingly, tight corner radii.
 */

export const WORDS_PER_MINUTE = Number(process.env.VO_WPM ?? 170);

/** Brand tokens lifted from envisionblockchain.com/styles.css. */
export const THEME = {
  bg: "#05070b",
  bgLift: "#0b0d10",
  panel: "#0e1116",
  line: "#1c212a",
  text: "#ffffff",
  dim: "#b6bec9",
  dimmer: "#6b7480",
  good: "#7ee0c3",
  bad: "#ff8087",
  iri1: "#56c8ff",
  iri2: "#7ee0c3",
  iri3: "#c99df0",
  iri4: "#ffc98a",
  ffDisplay: `"Source Serif 4", Georgia, "Times New Roman", serif`,
  ffSans: `"IBM Plex Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif`,
  ffMono: `"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace`,
};

export const SEGMENTS = [
  {
    id: "01-hook",
    kind: "slide",
    narration: `Two agents. Same service. Same price. Both paid on chain, in seconds, for a
      fraction of a cent. Both got back HTTP two hundred.
      One of them was robbed. Nothing before the payment could tell you which.`,
    slide: {
      layout: "hook",
      line1: "Two payments.",
      line2: "One robbery.",
      line3: "Nothing before the payment could tell them apart.",
    },
  },
  {
    id: "02-gap",
    kind: "slide",
    narration: `Because payment is not proof of delivery. A paying agent can verify who it paid,
      what it paid, and that the money landed. It cannot verify that it got the thing.
      So we built the part that was missing, on Hedera.`,
    slide: {
      layout: "split",
      title: "What a paying agent actually knows",
      leftHeading: "Verifiable",
      left: ["Who it paid", "What it paid", "That the money landed", "That the response was 200"],
      rightHeading: "Not verifiable",
      right: ["That it got the thing"],
      note: "Settlement and delivery are two different events. Only one of them is what you bought.",
    },
  },
  {
    id: "02b-what-is-sold",
    kind: "slide",
    narration: `So what is being sold here? A snapshot of a Hedera account. Its balance, its token
      count, at a moment in time. The buyer is an agent that needs the state of an account it does
      not run. A paid data API. Nothing exotic.
      And we picked that on purpose, because it is something you can check yourself. In production
      you buy the answers you cannot look up. That is exactly when this matters.`,
    slide: {
      layout: "compare",
      title: "What is being bought",
      rows: [
        { left: "The product", right: "A Hedera account snapshot: balance, token count, timestamp" },
        { left: "The buyer", right: "An agent needing account state it does not run infrastructure for" },
        { left: "The price", right: "0.01 HBAR, settled in about a second, no gas for the buyer" },
      ],
      highlight: "Deliberately something you can check yourself",
      note: "In production you buy what you cannot check. That is when an attestation is the only thing between you and the seller's word.",
    },
  },
  {
    id: "03-demo",
    kind: "terminal",
    narration: `One command. The buyer asks, gets a four oh two, and signs a native Hedera transfer
      it deliberately leaves incomplete. The facilitator co-signs as fee payer, so the buyer pays the
      price and never the gas.
      Then the verifier. It asks the seller nothing. It re-derives the answer from the mirror node.
      Fourteen checks. All pass. Delivered.
      Second seller. Payment settles. Two hundred. Schema valid. Identity resolves. Balance wrong.
      Caught. Everything above that line is identical.`,
    cast: "docs/media/demo.cast",
  },
  {
    id: "04-why-identity",
    kind: "slide",
    narration: `Here is why this needs identity. An attestation about a U R L is worthless. The
      seller just moves. An attestation about a decentralised identifier sticks.
      These are did hedera identities. The identifier is the public key, so the key an identity must
      sign with comes out of the identifier itself. Nobody to trust.
      And that same key is the key of the Hedera account that gets paid. Not because a document says
      so. Because the ledger says so, and the verifier checks it there.`,
    slide: {
      layout: "compare",
      title: "Why it needs identity",
      rows: [
        { left: "Attestation about a URL", right: "Seller moves. History gone." },
        { left: "Attestation about a DID", right: "History follows the identity." },
      ],
      highlight: "DID root key  ===  the Hedera account key that receives payment",
      note: "Checked against the ledger, not asserted in a document.",
    },
  },
  {
    id: "05-code",
    kind: "code",
    narration: `The code makes that structural, not rhetorical. Both sellers import the same payment
      gate and differ only in one handler. So identical payment behaviour is a property of the code.
      And the dishonest one fakes almost nothing. Right account. Real timestamp. Valid schema. Its own
      truthful identity. It lies about exactly one thing: the number you bought.`,
    code: {
      title: "One gate. One lie.",
      files: [
        { path: "src/seller/honest.ts", find: "return startSeller({", lines: 8 },
        { path: "src/seller/dishonest.ts", find: "return startSeller({", lines: 8 },
      ],
      note: "A shape check passes that response. Only re-derivation catches it.",
    },
  },
  {
    id: "06-repo",
    kind: "slide",
    narration: `The repository is small enough to read in one sitting, and laid out along the
      argument. Seller is the gate plus two handlers. Buyer is the paying agent and its spend cap.
      Verifier is the part that matters: re-derive, decide, attest.
      The decision logic is a pure function with no network in it, which is why it can be tested
      exhaustively. Three hundred and sixteen tests run in C I on every change.`,
    slide: {
      layout: "tree",
      title: "Where everything lives",
      entries: [
        { path: "src/hedera", label: "src/hedera/", what: "Client, did:hedera, mirror node, HBAR units" },
        { path: "src/seller/gate.ts", label: "src/seller/gate.ts", what: "The x402 payment gate. Both sellers share it" },
        { path: "src/seller/dishonest.ts", label: "src/seller/dishonest.ts", what: "The deliberate mock. Labelled as one, everywhere" },
        { path: "src/buyer/pay.ts", label: "src/buyer/pay.ts", what: "Signs the transfer. Refuses above the cap" },
        { path: "src/facilitator.ts", label: "src/facilitator.ts", what: "Refuses a facilitator that cannot settle here" },
        { path: "src/verifier/check.ts", label: "src/verifier/check.ts", what: "9 of the 14 ordered checks. Pure, fail-closed" },
        { path: "src/verifier/verify.ts", label: "src/verifier/verify.ts", what: "The other 5: identity, key binding, and three on the payment" },
        { path: "src/verifier/attest.ts", label: "src/verifier/attest.ts", what: "Signs the verdict onto Consensus Service" },
        { path: "skills/x402-hedera-buyer", label: "skills/x402-hedera-buyer/", what: "The buyer, packaged as an agent skill" },
        { path: "viewer/index.html", label: "viewer/index.html", what: "Independent reader. One file, no backend" },
        { path: "test", label: "test/", what: "316 tests, run in CI on every change" },
      ],
      note: "check.ts makes no network calls. That is why every branch of the decision is testable.",
    },
  },
  {
    id: "07-build",
    kind: "slide",
    narration: `And you can run the whole thing yourself in about five minutes. One funded testnet
      account from the Hedera portal is the only input. Setup proves the key controls the account
      before anything signs. Bootstrap provisions the identities and the attestation topic. Then one
      command runs both sellers, both payments, and both verdicts.`,
    slide: {
      layout: "steps",
      title: "Run it yourself",
      steps: [
        { cmd: "npm install", what: "Node 20 or newer" },
        { cmd: "npm run setup", what: "Confirms your key controls your account, before signing anything" },
        { cmd: "npm run bootstrap", what: "Provisions four did:hedera identities and the attestation topic, once" },
        { cmd: "npm start", what: "Both sellers, both payments, both verdicts, with HashScan links" },
      ],
      note: "One funded testnet account from portal.hedera.com is the only prerequisite. Total cost: zero.",
    },
  },
  {
    id: "08-agent",
    kind: "terminal",
    narration: `One more way in. The buyer is also packaged as an agent skill. The description is the part
      that matters. It tells an agent when to reach for this, and never to call an HTTP two hundred a
      success on its own.
      So the agent pays, and then re-derives the answer itself. Fourteen checks, and a verdict it never
      took the seller's word for.`,
    cast: "docs/media/skill.cast",
  },
  {
    id: "09-verify",
    kind: "slide",
    narration: `And you do not have to trust us. This page is one static file. It reads the attestation
      topic straight off the public mirror node, and checks every signature against the key the
      attester's identifier commits to. Not the key the message carries, which a forger controls.
      Two sellers, the same number of paid calls each. One delivered every time. The other, not once.
      And every payment succeeded.`,
    slide: { layout: "image", title: "Verify it without trusting us", image: "docs/media/viewer.png" },
  },
  {
    id: "10-close",
    kind: "slide",
    narration: `Payment rails tell you money moved. This tells you whether anyone got what they paid
      for, and writes it to the same Consensus Service the identities live on, for a fixed fraction of
      a cent.
      Eight years of trust infrastructure. Now the agent economy.`,
    slide: {
      layout: "close",
      line1: "We build the systems",
      line2: "that make claims provable.",
      kicker: "Envision Blockchain",
      footer: "Apache-2.0 · Hedera testnet · every transaction live on HashScan",
    },
  },
];

/** Background score, generated once and mixed under the narration. */
export const MUSIC = {
  prompt:
    "Restrained minimal electronic underscore for a serious technical product film. " +
    "Steady low pulse, sparse analog synth pads, subtle rising tension, no drums after " +
    "the first third, no melody that competes with speech, clean and modern, understated.",
  /** Mixed well under the voice: present, never fighting the narration. */
  gainDb: Number(process.env.MUSIC_DB ?? -21),
  file: "docs/media/score.mp3",
};

export function spoken(text) {
  return text.replace(/\s+/g, " ").trim();
}

export function estimateSeconds(text) {
  return (spoken(text).split(" ").length / WORDS_PER_MINUTE) * 60;
}
