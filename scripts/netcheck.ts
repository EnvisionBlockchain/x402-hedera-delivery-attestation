/**
 * Network preflight.
 *
 * Prints everything that changes with `HEDERA_NETWORK` and proves each piece is
 * actually reachable, without signing anything or spending anything. Run it
 * after switching networks and before running the demo.
 *
 * The check that matters is the last one: a facilitator left pinned in `.env`
 * from a different network cannot settle here, and this is where that shows up
 * rather than mid-payment.
 *
 *   npm run netcheck
 *   HEDERA_NETWORK=mainnet npm run netcheck
 */
import {
  caip2Network,
  facilitatorUrl,
  hashscanTx,
  maxSpendHbar,
  mirrorNodeUrl,
  network,
  networkBanner,
  priceHbar,
} from "../src/config.js";
import { supportedNetworks } from "../src/facilitator.js";
import { readBalanceSnapshotAt } from "../src/hedera/mirror.js";
import { formatHbar } from "../src/hedera/units.js";

async function main(): Promise<void> {
  console.log(`\nHedera network preflight`);
  console.log(`  ${networkBanner()}\n`);
  console.log(`  x402 network     : ${caip2Network()}`);
  console.log(`  mirror node      : ${mirrorNodeUrl()}`);
  console.log(`  facilitator      : ${facilitatorUrl()}`);
  console.log(`  price per call   : ${priceHbar()} HBAR`);
  console.log(`  buyer spend cap  : ${maxSpendHbar()} HBAR`);
  console.log(`  explorer         : ${hashscanTx("<transaction-id>")}`);

  let ok = true;

  try {
    const snapshot = await readBalanceSnapshotAt("0.0.2");
    console.log(
      `\n  mirror node ok       : 0.0.2 holds ${formatHbar(snapshot.balanceHbar)} HBAR ` +
        `at ${snapshot.snapshotTimestamp}`,
    );
  } catch (error) {
    ok = false;
    console.log(`\n  MIRROR NODE UNREACHABLE: ${error instanceof Error ? error.message : error}`);
  }

  try {
    const advertised = await supportedNetworks(facilitatorUrl());
    const matches = advertised.includes(caip2Network());
    if (!matches) ok = false;
    console.log(`  facilitator settles  : ${advertised.join(", ") || "(nothing)"}`);
    console.log(
      matches
        ? `  facilitator matches  : yes`
        : `  facilitator matches  : NO. It cannot settle on ${caip2Network()}.\n` +
            `                         Unset FACILITATOR_URL to get the ${network()} default.`,
    );
  } catch (error) {
    ok = false;
    console.log(`  FACILITATOR UNREACHABLE: ${error instanceof Error ? error.message : error}`);
  }

  console.log(
    ok
      ? `\n  Configuration is coherent. Safe to run npm start on ${network()}.\n`
      : `\n  Configuration is NOT usable. Fix the above before running anything that signs.\n`,
  );
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("preflight failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
