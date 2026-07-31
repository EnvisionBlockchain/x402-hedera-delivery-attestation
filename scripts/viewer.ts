/**
 * Opens the attestation viewer on your own topic.
 *
 * The viewer is one static file with no build step and no server, which is the
 * point of it: it depends on nothing this repository runs. That also makes it
 * the one part of the demo with no obvious way to launch it. Every other action
 * here is an `npm run`, so this is too.
 *
 * The topic comes from `.env` rather than from `process.env`, so it is the one
 * this clone provisioned rather than whatever the shell happened to inherit.
 * Passing a topic id or a full URL overrides it:
 *
 *   npm run viewer
 *   npm run viewer -- 0.0.9857228
 *   npm run viewer -- --print          # just print the URL, open nothing
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { network } from "../src/config.js";
import { ENV_PATH, readEnvFile } from "../src/envfile.js";
import { c, field } from "../src/term.js";

const VIEWER = "viewer/index.html";

/**
 * The command this platform uses to hand a URL to the default browser.
 *
 * @returns Command and its leading arguments, or null on an unknown platform
 */
function opener(): { command: string; args: string[] } | null {
  if (process.platform === "darwin") return { command: "open", args: [] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  if (process.platform === "linux") return { command: "xdg-open", args: [] };
  return null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const printOnly = argv.includes("--print");
  const supplied = argv.find((value) => !value.startsWith("--"));

  const topicId = supplied ?? readEnvFile(ENV_PATH).ATTESTATION_TOPIC_ID;
  if (!topicId) {
    throw new Error(
      `No attestation topic found in ${ENV_PATH}.\n` +
        "  Run `npm start` first; it provisions one and writes it there.\n" +
        "  Or name a topic directly: npm run viewer -- 0.0.9857228",
    );
  }

  const file = resolve(process.cwd(), VIEWER);
  if (!existsSync(file)) {
    throw new Error(`${VIEWER} not found. Run this from the repository root.`);
  }

  // The network travels with the topic. A topic id means nothing without it,
  // and the page defaults to testnet, so a mainnet ledger would render empty.
  const url =
    `file://${file}?topic=${encodeURIComponent(topicId)}` +
    (network() === "mainnet" ? "&network=mainnet" : "");

  console.log(field("topic", topicId));
  console.log(field("network", network()));
  console.log(`\n  ${c.teal(url)}\n`);

  if (printOnly) return;

  const launcher = opener();
  if (!launcher) {
    console.log(c.dim("  Unknown platform. Open the URL above in a browser."));
    return;
  }

  // Detached and unref'd: this should not hold the terminal open for as long as
  // the browser lives.
  const child = spawn(launcher.command, [...launcher.args, url], {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => {
    console.log(c.dim(`  Could not run \`${launcher.command}\`. Open the URL above in a browser.`));
  });
  child.unref();
  console.log(c.dim("  Opening in your default browser..."));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
