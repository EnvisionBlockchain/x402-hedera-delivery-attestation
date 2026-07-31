/**
 * Deterministic buyer CLI.
 *
 * Pays any x402-gated Hedera endpoint and prints what came back. With
 * --verify it also re-derives the answer independently and says whether the
 * response is actually the purchased resource.
 *
 * No model in the loop: the demo has to run the same way twice, on camera.
 * The skill in skills/x402-hedera-buyer drives this, rather than replacing it.
 */
import { credentials, hashscanTx, network, networkBanner, snapshotAccountId } from "../config.js";
import { c, fail, field, pass } from "../term.js";
import { assertSingleSdkInstance, resolveSigningKey } from "../hedera/client.js";
import { verifyDelivery } from "../verifier/verify.js";
import { createBuyer, payAndFetch } from "./pay.js";

type Args = { url: string; account: string; verify: boolean };

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const url = get("--url");
  if (!url) {
    throw new Error(
      "Usage: npm run buy -- --url <endpoint> [--account 0.0.2] [--verify]\n" +
        "  --url      x402-gated endpoint to buy from\n" +
        "  --account  Hedera account to request a snapshot of\n" +
        "  --verify   independently check that the response is the purchased resource",
    );
  }
  return {
    url,
    account: get("--account") ?? snapshotAccountId(),
    verify: argv.includes("--verify"),
  };
}

async function main(): Promise<void> {
  assertSingleSdkInstance();
  const args = parseArgs(process.argv.slice(2));

  // This command signs a payment to whatever endpoint it is pointed at, so the
  // network it is about to spend on is stated before anything else happens.
  console.log(`x402 buyer on Hedera ${network()}`);
  console.log(`  ${networkBanner()}\n`);

  const buyerCreds = credentials.buyer();
  const key = await resolveSigningKey(buyerCreds.accountId, buyerCreds.privateKey, buyerCreds.label);
  const client = createBuyer(buyerCreds.accountId, key);

  // A URL that already carries ?account= wins, but the verifier has to be told
  // about it. Passing --account's default alongside a URL naming a different
  // account made an honest seller fail account_matches and exit 2, which reads
  // as "it did not deliver" when it did.
  const url = args.url.includes("?")
    ? args.url
    : `${args.url}?account=${encodeURIComponent(args.account)}`;
  const requestedAccount = new URL(url).searchParams.get("account") ?? args.account;

  console.log(c.bold(`Buying from ${c.link(url)}`));
  console.log(`  ${c.dim("as")} ${buyerCreds.accountId}\n`);

  const call = await payAndFetch(client, url, (message) => console.log(`  ${c.dim(message)}`));

  console.log(`\n${c.bold("Paid.")} HTTP ${c.ok(String(call.httpStatus))}`);
  console.log(field("transaction", call.transactionId, 12));
  console.log(field("hashscan", c.link(hashscanTx(call.transactionId)), 12));
  console.log(field("response", call.rawBody, 12));

  if (!args.verify) {
    console.log("\nPayment settled. Whether you received what you paid for is a separate");
    console.log("question: re-run with --verify to find out.");
    return;
  }

  console.log(c.dim("\nVerifying independently against the Hedera mirror node..."));
  const verdict = await verifyDelivery({
    rawBody: call.rawBody,
    requestedAccount,
    advertisedSellerDid: call.advertisedSellerDid,
    payTo: call.payTo,
    paymentTxId: call.transactionId,
    signedTransactionId: call.signedTransactionId,
    transactionIdMatches: call.transactionIdMatches,
    amountHbar: call.amountHbar,
  });
  for (const check of verdict.checks) {
    console.log(check.passed ? pass(check.name, check.detail) : fail(check.name, check.detail));
  }
  console.log(
    verdict.delivered
      ? `\n${c.bold(c.ok("VERDICT: DELIVERED"))}`
      : `\n${c.bold(c.bad("VERDICT: NOT DELIVERED"))}`,
  );
  console.log(c.dim(verdict.reason));
  if (!verdict.delivered) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
