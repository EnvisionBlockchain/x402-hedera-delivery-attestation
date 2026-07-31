/**
 * The one command.
 *
 * Provisions whatever is missing, then runs the full demo. Idempotent: running
 * it twice does not create a second set of accounts and identities.
 *
 * Steps run as child processes so each picks up a freshly written .env rather
 * than the environment this process started with.
 */
import { spawnSync } from "node:child_process";

import { credentials, network, networkBanner } from "../src/config.js";
import { banner, c, field } from "../src/term.js";
import { ENV_PATH, isProvisioned, readEnvFile } from "../src/envfile.js";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function run(script: string): void {
  const result = spawnSync(NPM, ["run", "--silent", script], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`\`npm run ${script}\` exited with code ${result.status}.`);
  }
}

function main(): void {
  console.log(banner(`x402 delivery attestation on Hedera ${network()}`));

  // Fails with setup guidance naming the exact variables when absent.
  const buyer = credentials.buyer();
  console.log(`\n${field("operator account", buyer.accountId)}`);
  console.log(`  ${network() === "mainnet" ? c.warn(networkBanner()) : c.dim(networkBanner())}`);

  const reprovision = process.argv.includes("--reprovision");

  if (reprovision || !isProvisioned()) {
    console.log(
      reprovision
        ? "\n  reprovisioning as requested\n"
        : "\n  first run: provisioning accounts, identities, and the attestation topic\n",
    );
    run("bootstrap");
  } else {
    console.log(c.dim(`\n  already provisioned (from ${ENV_PATH}), skipping bootstrap`));
    console.log(c.dimmer("  pass --reprovision to create a fresh set\n"));
  }

  run("demo");

  console.log(`\n${banner("next", "lavender")}`);
  console.log(`\n  ${c.teal("npm run attestations")}      ${c.dim("read the verdicts back, verifying every signature")}`);

  // Read the topic from disk, not from process.env.
  //
  // `dotenv` runs once, when src/config.js is first imported, which is before
  // bootstrap has written anything. On a first run that leaves the variable
  // unset, and reading it through `provisioned` threw here after bootstrap and
  // the demo had both already succeeded: a zero-value crash at the very end of
  // the one command a newcomer runs. With --reprovision it was quieter and
  // worse, printing the topic id from the previous run as though it were the
  // new one.
  const topicId = readEnvFile(ENV_PATH).ATTESTATION_TOPIC_ID;
  if (topicId) {
    // Name the caller's own topic. The viewer ships with ours as a placeholder,
    // so an unparameterised link would show them our ledger and call it theirs.
    console.log(`  ${c.teal("npm run viewer")}${c.dim("            your reputation ledger, live from the mirror node")}`);
    console.log(c.dim(`                            opens topic ${topicId} in your browser`));
  }
  console.log("");
}

try {
  main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
