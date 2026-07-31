/**
 * Credential preflight.
 *
 * Confirms that the configured private key actually controls the configured
 * account, before anything tries to sign a transfer. A mismatch surfaces on
 * chain as an opaque INVALID_SIGNATURE, which is a miserable thing to debug.
 *
 * When the pair does not match, this reverse-looks-up the key against the
 * mirror node to find the account it does control, so the fix is obvious
 * rather than a guessing game.
 *
 * Prints public key material only. Never prints the private key.
 */
import { credentials, hashscanAccount, mirrorNodeUrl, network } from "../src/config.js";
import { assertSingleSdkInstance, derivePublicKeyCandidates } from "../src/hedera/client.js";
import { formatHbar, toHbar } from "../src/hedera/units.js";

type MirrorAccount = {
  account?: string;
  balance?: { balance?: number };
  key?: { _type?: string; key?: string };
  deleted?: boolean;
};

async function fetchAccount(accountId: string): Promise<MirrorAccount | null> {
  const response = await fetch(`${mirrorNodeUrl()}/api/v1/accounts/${accountId}?limit=1`);
  if (!response.ok) return null;
  return (await response.json()) as MirrorAccount;
}

async function accountsForPublicKey(publicKey: string): Promise<MirrorAccount[]> {
  const response = await fetch(
    `${mirrorNodeUrl()}/api/v1/accounts?account.publickey=${publicKey}&limit=5`,
  );
  if (!response.ok) return [];
  const body = (await response.json()) as { accounts?: MirrorAccount[] };
  return body.accounts ?? [];
}

async function check(label: string, accountId: string, privateKey: string): Promise<boolean> {
  console.log(`\n${label}  (configured account ${accountId})`);

  const info = await fetchAccount(accountId);
  if (!info) {
    console.log(`  account      : NOT FOUND on ${network()}`);
  } else {
    const tinybars = info.balance?.balance ?? 0;
    console.log(`  account      : exists${info.deleted ? " (DELETED)" : ""}`);
    console.log(`  balance      : ${formatHbar(toHbar(String(tinybars)))} HBAR`);
    console.log(`  onchain key  : ${info.key?._type ?? "unknown"} ${info.key?.key ?? ""}`);
    console.log(`  hashscan     : ${hashscanAccount(accountId)}`);
  }

  if (!privateKey) {
    console.log("  key check    : skipped, no private key configured");
    return false;
  }

  const candidates = derivePublicKeyCandidates(privateKey);
  const onchain = (info?.key?.key ?? "").toLowerCase();
  let matched = false;

  console.log("  key derives  :");
  for (const candidate of candidates) {
    const hit = onchain !== "" && candidate.publicKey.toLowerCase() === onchain;
    if (hit) matched = true;
    console.log(`    ${candidate.curve.padEnd(8)} ${candidate.publicKey} ${hit ? "  <-- MATCHES" : ""}`);
  }

  if (matched) {
    const tinybars = info?.balance?.balance ?? 0;
    if (tinybars === 0) {
      console.log("\n  Key controls the account, but the balance is zero.");
      console.log("  Fund it from the faucet at https://portal.hedera.com/");
      return false;
    }
    console.log("\n  Key controls this account and it is funded. Usable.");
    return true;
  }

  console.log("\n  This key does NOT control the configured account.");
  console.log("  Searching the mirror node for the account this key actually controls...");

  for (const candidate of candidates) {
    const found = await accountsForPublicKey(candidate.publicKey);
    for (const account of found) {
      const tinybars = account.balance?.balance ?? 0;
      console.log(
        `    ${candidate.curve}: account ${account.account}  ${formatHbar(toHbar(String(tinybars)))} HBAR`,
      );
    }
    if (found.length === 0) {
      console.log(`    ${candidate.curve}: no account on ${network()} uses this public key`);
    }
  }

  console.log(
    `\n  If nothing was found, this key has never been used to create a ${network()} account.\n` +
      "  Copy the account id and its private key from the SAME card on https://portal.hedera.com/",
  );
  return false;
}

async function main(): Promise<void> {
  assertSingleSdkInstance();
  console.log(`Hedera ${network()} credential preflight`);

  const buyer = credentials.buyer();
  const ok = await check("buyer", buyer.accountId, buyer.privateKey);

  console.log("");
  if (ok) {
    console.log("Credentials usable. Next: npm run smoke");
  } else {
    console.log("Credentials NOT usable. Fix the above before running the smoke test.");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("preflight failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
