/**
 * The seller that delivers what it was paid for.
 *
 * Queries the Hedera mirror node for a balance snapshot and returns exactly
 * what it found.
 */
import { credentials, mirrorNodeUrl, ports, provisioned } from "../config.js";
import { readBalanceSnapshotAt } from "../hedera/mirror.js";
import { startSeller, type RunningSeller } from "./gate.js";

/** Re-exported so the record can name its own source. Follows the network. */
export const MIRROR_NODE = mirrorNodeUrl();

/**
 * Builds the purchased resource from live mirror node data.
 *
 * @param requestedAccount - Account the buyer asked about
 * @param servedBy - DID of the seller producing this record
 * @returns The snapshot record
 */
export async function buildSnapshotRecord(
  requestedAccount: string,
  servedBy: string,
): Promise<Record<string, unknown>> {
  const snapshot = await readBalanceSnapshotAt(requestedAccount);
  return {
    resource: "hedera-account-snapshot",
    version: "1",
    account: requestedAccount,
    snapshotTimestamp: snapshot.snapshotTimestamp,
    balanceHbar: snapshot.balanceHbar,
    tokenCount: snapshot.tokenCount,
    sourceMirrorNode: MIRROR_NODE,
    servedBy,
  };
}

/**
 * Starts the honest seller.
 *
 * @returns The running seller
 */
export async function startHonestSeller(): Promise<RunningSeller> {
  const seller = credentials.seller();
  const did = provisioned.did("SELLER");
  return startSeller({
    role: "honest seller",
    port: ports.honestSeller,
    payTo: seller.accountId,
    did,
    handler: (account) => buildSnapshotRecord(account, did),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startHonestSeller().catch((error: unknown) => {
    console.error("honest seller failed to start:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
