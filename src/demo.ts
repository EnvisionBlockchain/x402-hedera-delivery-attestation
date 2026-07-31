/**
 * The whole demo, in one command.
 *
 * Runs the identical flow twice: once against a seller that delivers, once
 * against a seller that takes the money and returns fabricated values. The
 * payments are indistinguishable. Only the attestation layer separates them.
 */
import {
  credentials,
  hashscanTopic,
  hashscanTx,
  network,
  provisioned,
  snapshotAccountId,
} from "./config.js";
import { assertFacilitatorMatchesNetwork } from "./facilitator.js";
import { assertSingleSdkInstance, hederaClientWithKey, resolveSigningKey } from "./hedera/client.js";
import { formatHbar } from "./hedera/units.js";
import { banner, c, fail, field, pad, pass, rule } from "./term.js";
import { createBuyer, payAndFetch, type PaidCall } from "./buyer/pay.js";
import { startDishonestSeller } from "./seller/dishonest.js";
import { startHonestSeller } from "./seller/honest.js";
import { buildAttestation, publishAttestation, signAttestation } from "./verifier/attest.js";
import { verifyDelivery } from "./verifier/verify.js";
import type { DeliveryVerdict } from "./verifier/check.js";
import type { RunningSeller } from "./seller/gate.js";


type Outcome = {
  readonly label: string;
  readonly call: PaidCall;
  readonly verdict: DeliveryVerdict;
  readonly sequenceNumber: string;
};

function heading(text: string, accent: "cyan" | "teal" | "red" = "cyan"): void {
  console.log(`\n${banner(text, accent)}`);
}

async function runAgainst(
  label: string,
  seller: RunningSeller,
  context: {
    buyer: ReturnType<typeof createBuyer>;
    buyerDid: string;
    attesterDid: string;
    account: string;
    verifierKey: Parameters<typeof signAttestation>[1];
    publish: (signedPayload: ReturnType<typeof signAttestation>) => Promise<string>;
  },
  accent: "cyan" | "teal" | "red" = "cyan",
): Promise<Outcome> {
  heading(label, accent);
  const url = `${seller.url}?account=${encodeURIComponent(context.account)}`;
  console.log(`  ${c.dim("buying a snapshot of")} ${context.account} ${c.dim("from")} ${c.link(url)}\n`);

  const call = await payAndFetch(context.buyer, url, (message) =>
    console.log(`  ${c.lavender("[buyer]")}    ${message}`),
  );
  console.log(`  ${c.lavender("[buyer]")}    ${c.bold("paid.")} HTTP ${c.ok(String(call.httpStatus))}, tx ${call.transactionId}`);
  console.log(`  ${c.lavender("[buyer]")}    ${c.link(hashscanTx(call.transactionId))}`);
  console.log(
    `  ${c.lavender("[buyer]")}    received ${call.rawBody.length} bytes. ` +
      c.dim("Whether it is the right thing, the buyer cannot say."),
  );

  console.log(`\n  ${c.cyan("[verifier]")} ${c.dim("independently re-deriving the answer from the mirror node")}`);
  const verdict = await verifyDelivery({
    rawBody: call.rawBody,
    requestedAccount: context.account,
    advertisedSellerDid: call.advertisedSellerDid,
    payTo: call.payTo,
    paymentTxId: call.transactionId,
    signedTransactionId: call.signedTransactionId,
    transactionIdMatches: call.transactionIdMatches,
    amountHbar: call.amountHbar,
  });
  for (const check of verdict.checks) {
    console.log(`  ${c.cyan("[verifier]")} ${check.passed ? pass(check.name) : fail(check.name)}`);
  }
  const stamp = verdict.delivered
    ? c.bold(c.ok("VERDICT: DELIVERED"))
    : c.bold(c.bad("VERDICT: NOT DELIVERED"));
  console.log(`\n  ${c.cyan("[verifier]")} ${stamp}`);
  console.log(`  ${c.cyan("[verifier]")} ${c.dim(verdict.reason)}`);

  const signed = signAttestation(
    buildAttestation({
      service: url,
      paymentTxId: call.transactionId,
      sellerDid: call.advertisedSellerDid,
      buyerDid: context.buyerDid,
      attesterDid: context.attesterDid,
      delivered: verdict.delivered,
      reason: verdict.reason,
      rawResponseBody: call.rawBody,
      attestedAt: new Date().toISOString(),
    }),
    context.verifierKey,
  );
  const sequenceNumber = await context.publish(signed);
  console.log(
    `  ${c.cyan("[verifier]")} ${c.dim("attestation published to HCS, sequence")} ${c.lavender("#" + sequenceNumber)}`,
  );

  return { label, call, verdict, sequenceNumber };
}

async function main(): Promise<void> {
  assertSingleSdkInstance();
  await assertFacilitatorMatchesNetwork();

  const buyerCreds = credentials.buyer();
  const verifierCreds = credentials.verifier();
  const account = snapshotAccountId();
  const topicId = provisioned.attestationTopicId();

  const buyerKey = await resolveSigningKey(buyerCreds.accountId, buyerCreds.privateKey, buyerCreds.label);
  const verifierKey = await resolveSigningKey(
    verifierCreds.accountId,
    verifierCreds.privateKey,
    verifierCreds.label,
  );
  const verifierClient = hederaClientWithKey(verifierCreds.accountId, verifierKey);
  const buyer = createBuyer(buyerCreds.accountId, buyerKey);

  const context = {
    buyer,
    buyerDid: provisioned.did("BUYER"),
    attesterDid: provisioned.did("VERIFIER"),
    account,
    verifierKey,
    publish: async (signed: ReturnType<typeof signAttestation>) => {
      const result = await publishAttestation(verifierClient, topicId, signed);
      return result.sequenceNumber;
    },
  };

  console.log(c.bold(`x402 delivery attestation on Hedera ${network()}`));
  console.log(field("attestation topic", `${topicId}  ${c.link(hashscanTopic(topicId))}`));

  // Started inside the try so any later failure still runs the finally that
  // closes them. Outside, a mid-demo error orphaned both listeners and the next
  // run died on EADDRINUSE.
  let honest: RunningSeller | null = null;
  let dishonest: RunningSeller | null = null;

  try {
    honest = await startHonestSeller();
    dishonest = await startDishonestSeller();

    const good = await runAgainst("ACT 1  a seller that delivers", honest, context, "teal");
    const bad = await runAgainst("ACT 2  a seller that does not", dishonest, context, "red");

    heading("THE CONTRAST");
    // The argument of the whole demo is that every row but the last is
    // identical, so every row is read back off the two runs rather than
    // asserted. A hardcoded YES here would be the demo agreeing with itself:
    // if a check ever failed, the table would still claim the sellers were
    // indistinguishable, which is exactly the sentence a reader is being asked
    // to take on trust.
    const row = (name: string, a: string, b: string): void =>
      console.log(`  ${c.dim(pad(name, 26))} ${pad(a, 22)} ${b}`);
    const compare = (name: string, a: string, b: string): void =>
      a === b ? row(name, c.dimmer(a), c.dimmer(b)) : row(name, c.ok(a), c.bad(b));
    const divider = (): void => console.log(`  ${rule("─", 70)}`);

    /** Whether a named check passed in a run, as a table cell. */
    const checked = (run: typeof good, name: string): string => {
      const check = run.verdict.checks.find((entry) => entry.name === name);
      return check ? (check.passed ? "YES" : "NO") : "n/a";
    };

    console.log(`  ${pad("", 26)} ${c.bold(pad(c.teal("honest seller"), 22))} ${c.bold(c.red("dishonest seller"))}`);
    divider();
    compare(
      "payment settled",
      checked(good, "payment_confirmed_on_chain"),
      checked(bad, "payment_confirmed_on_chain"),
    );
    compare(
      "amount",
      `${formatHbar(good.call.amountHbar)} HBAR`,
      `${formatHbar(bad.call.amountHbar)} HBAR`,
    );
    compare("HTTP status", String(good.call.httpStatus), String(bad.call.httpStatus));
    compare("response is well formed", checked(good, "schema_valid"), checked(bad, "schema_valid"));
    compare(
      "identity resolves on HCS",
      checked(good, "seller_identity_resolves"),
      checked(bad, "seller_identity_resolves"),
    );
    divider();
    row(
      "RESOURCE DELIVERED",
      c.bold(good.verdict.delivered ? c.ok("YES") : c.bad("NO")),
      c.bold(bad.verdict.delivered ? c.ok("YES") : c.bad("NO")),
    );
    divider();
    console.log(
      `\n  ${c.dim("Everything above the line is identical.")} ` +
        c.bold("Only the attestation tells them apart."),
    );

    console.log(`\n  ${c.bold("Payments:")}`);
    console.log(`    ${c.teal("honest")}    ${c.link(hashscanTx(good.call.transactionId))}`);
    console.log(`    ${c.red("dishonest")} ${c.link(hashscanTx(bad.call.transactionId))}`);
    console.log(`\n  ${c.bold("Attestations:")}`);
    console.log(
      `    ${c.dim("topic")} ${topicId}${c.dim(", sequences")} ` +
        `${c.lavender("#" + good.sequenceNumber)} ${c.dim("and")} ${c.lavender("#" + bad.sequenceNumber)}`,
    );
    console.log(`    ${c.link(hashscanTopic(topicId))}`);
    console.log("\n  Read them back independently with: npm run attestations");
    console.log("  Or open the ledger in a browser with: npm run viewer");
  } finally {
    await honest?.close();
    await dishonest?.close();
    verifierClient.close();
  }
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:", error instanceof Error ? error.message : String(error));
  console.error(
    "\nIf this is a missing env var, run `npm run bootstrap` and paste its output into .env.\n" +
      "If the facilitator is unreachable, set FACILITATOR_URL to another that settles on\n" +
      "this network. See https://blocky402.com/docs/ to run your own.",
  );
  process.exitCode = 1;
});
