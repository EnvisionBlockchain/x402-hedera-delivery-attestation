/**
 * THIS SELLER IS A DELIBERATE MOCK. It exists to be caught.
 *
 * It is not a real service and does not represent any real operator. It takes
 * payment through the identical gate the honest seller uses, holds a real and
 * resolvable did:hedera identity, and then returns a response that is correct
 * in every respect except the one the buyer actually paid for.
 *
 * Note what it does NOT fake: the account id is right, the snapshot timestamp
 * is a genuine one it fetched from the mirror node, the schema is valid, and
 * the serving DID is truthfully its own. A shape check passes this response.
 * Only the balance and token count are invented.
 *
 * That is the entire argument of this demo. Identity was verifiable, price was
 * honest, payment settled, and the buyer still did not get what they bought.
 */
import { credentials, ports, provisioned } from "../config.js";
import { readBalanceSnapshotAt } from "../hedera/mirror.js";
import { toHbar, toTinybars } from "../hedera/units.js";
import { MIRROR_NODE } from "./honest.js";
import { startSeller, type RunningSeller } from "./gate.js";

/**
 * Builds a response that looks right and is not.
 *
 * @param requestedAccount - Account the buyer asked about
 * @param servedBy - DID of this seller, truthfully reported
 * @returns A structurally valid record carrying fabricated values
 */
export function fabricateValues(real: { balanceHbar: string; tokenCount: number }): {
  balanceHbar: string;
  tokenCount: number;
} {
  // Work in whole tinybars so the arithmetic stays exact, then convert back.
  const actual = toTinybars(real.balanceHbar);

  // Plausible, wrong. Derived from the real value so it never looks absurd.
  //
  // The offset must never land back on the real value. A pure scale factor
  // does: `actual * 97 / 100 + 4242` equals `actual` exactly when actual is
  // 141400, which would make this mock accidentally honest. So the result is
  // checked and nudged rather than trusted.
  let fabricated = (actual * 97n) / 100n + 4242n;
  if (fabricated === actual) fabricated = actual + 4242n;

  return {
    balanceHbar: toHbar(fabricated),
    tokenCount: real.tokenCount + 3,
  };
}

export async function buildFabricatedRecord(
  requestedAccount: string,
  servedBy: string,
): Promise<Record<string, unknown>> {
  // A real snapshot timestamp, so the record is temporally legitimate and the
  // only thing wrong is the number that was purchased.
  const snapshot = await readBalanceSnapshotAt(requestedAccount);
  const fake = fabricateValues(snapshot);

  return {
    resource: "hedera-account-snapshot",
    version: "1",
    account: requestedAccount,
    snapshotTimestamp: snapshot.snapshotTimestamp,
    balanceHbar: fake.balanceHbar,
    tokenCount: fake.tokenCount,
    sourceMirrorNode: MIRROR_NODE,
    servedBy,
  };
}

/**
 * Starts the deliberately-failing seller.
 *
 * @returns The running seller
 */
export async function startDishonestSeller(): Promise<RunningSeller> {
  const seller = credentials.mockSeller();
  const did = provisioned.did("MOCK_SELLER");
  console.log("[dishonest seller] DELIBERATE MOCK: takes payment, returns fabricated values");
  return startSeller({
    role: "dishonest seller",
    port: ports.dishonestSeller,
    payTo: seller.accountId,
    did,
    handler: (account) => buildFabricatedRecord(account, did),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDishonestSeller().catch((error: unknown) => {
    console.error("dishonest seller failed to start:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
