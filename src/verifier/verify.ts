/**
 * The verifier's network-facing side.
 *
 * Everything here talks to the mirror node. The actual decision logic lives in
 * check.ts and stays pure, so it can be exhaustively tested against fixtures
 * without a network.
 *
 * Two independent things are established before a verdict is reached:
 *   1. The identity the seller advertised really does control the account that
 *      received the money. Otherwise "seller X was paid" is unfounded.
 *   2. The values in the response match what the mirror node says, fetched by
 *      the verifier itself rather than taken from the seller.
 */
import { accountKeyMatchesDid, resolveDid } from "../hedera/did.js";
import {
  readBalanceSnapshotAt,
  readTransaction,
  type ConfirmedTransaction,
} from "../hedera/mirror.js";
import { formatHbar, toHbar, toTinybars } from "../hedera/units.js";
import { checkDelivery, type DeliveryCheck, type DeliveryVerdict } from "./check.js";

export type VerifyArgs = {
  readonly rawBody: string;
  readonly requestedAccount: string;
  /** DID the seller advertised in its 402, before payment. */
  readonly advertisedSellerDid: string;
  /** Account that actually received the payment. */
  readonly payTo: string;
  /**
   * The verifier's own clock, used to bound snapshot staleness. Defaults to now;
   * tests pin it so freshness assertions do not depend on wall clock.
   */
  readonly verifiedAt?: Date;
  /** Override for the staleness bound. */
  readonly maxSnapshotAgeSeconds?: number;
  /** Transaction id the seller relayed in PAYMENT-RESPONSE. */
  readonly paymentTxId?: string;
  /** Transaction id decoded from what the buyer actually signed. */
  readonly signedTransactionId?: string;
  /**
   * Price the buyer actually paid, in HBAR.
   *
   * Checked against the ledger's own transfer list, so that "the payment
   * settled" cannot stand in for "the seller was paid".
   */
  readonly amountHbar?: string;
  /** Whether the buyer found those two ids to agree. */
  readonly transactionIdMatches?: boolean;
  /** How long to wait out mirror node ingestion when confirming the payment. */
  readonly paymentConfirmTimeoutMs?: number;
};

/**
 * Confirms an advertised DID controls the account that was paid.
 *
 * Without this, a seller could advertise someone else's reputable identity and
 * take payment to an account that identity has nothing to do with.
 *
 * Two separate things are established, in order. First that the DID resolves at
 * all, which proves the identity was published and that the document on its
 * topic is the one the DID commits to. Then that the DID's root key is the key
 * the ledger records as controlling the account that received the money. The
 * second check reads the account from the mirror node rather than believing a
 * field in the document, so a seller cannot assert a binding it does not have.
 *
 * @param did - DID advertised by the seller
 * @param payTo - Account that received payment
 * @returns Two checks: resolution, then the key binding
 */
async function checkIdentityBinding(did: string, payTo: string): Promise<DeliveryCheck[]> {
  if (!did) {
    return [
      {
        name: "seller_identity_resolves",
        passed: false,
        detail: "the seller advertised no DID in its payment requirements",
      },
    ];
  }

  const document = await resolveDid(did);
  if (!document) {
    return [
      {
        name: "seller_identity_resolves",
        passed: false,
        detail: `${did} could not be resolved through the mirror node, or the document on its topic is not the one the DID commits to`,
      },
    ];
  }

  const resolved: DeliveryCheck = {
    name: "seller_identity_resolves",
    passed: true,
    detail: `${did} resolves, and its published root key matches the key the DID itself commits to`,
  };

  const binding = await accountKeyMatchesDid(did, payTo);
  return [resolved, { name: "seller_identity_controls_paid_account", ...bindingVerdict(binding, payTo) }];
}

/**
 * Turns a key comparison into a check, distinguishing "asked and the answer was
 * no" from "could not ask".
 *
 * Both fail, and both should. Reporting them the same way would have the demo
 * claim an impersonation it never established.
 */
function bindingVerdict(
  binding: Awaited<ReturnType<typeof accountKeyMatchesDid>>,
  payTo: string,
): { passed: boolean; detail: string } {
  if (binding.matches) {
    return {
      passed: true,
      detail: `the ledger records ${payTo}, the account that was paid, as controlled by this DID's root key`,
    };
  }
  if (!binding.reachable) {
    return {
      passed: false,
      detail: `the mirror node could not be asked which key controls ${payTo}, so this DID's claim to it is unestablished`,
    };
  }
  if (binding.accountKey === null) {
    return {
      passed: false,
      detail: `${payTo} is controlled by ${binding.accountKeyType ?? "a key of unreported type"}, which cannot be a did:hedera root key, so no identity can prove control of it this way`,
    };
  }
  return {
    passed: false,
    detail: `this DID's root key is ${binding.didKey}, but the ledger records ${payTo} as controlled by ${binding.accountKey}`,
  };
}

/**
 * Confirms the payment the attestation is about actually reached consensus.
 *
 * The transaction id arrives from the seller-relayed PAYMENT-RESPONSE header, and
 * it gets signed into a permanent record. Two things therefore need establishing
 * independently: that the id is the one the buyer signed, and that the ledger
 * agrees it succeeded.
 *
 * @param args - Verification arguments carrying the payment context
 * @returns The two payment checks, in order
 */
async function checkPayment(args: VerifyArgs): Promise<DeliveryCheck[]> {
  const relayed = String(args.paymentTxId ?? "").trim();
  const signed = String(args.signedTransactionId ?? "").trim();
  const checks: DeliveryCheck[] = [];

  if (signed === "") {
    checks.push({
      name: "payment_id_matches_signed",
      passed: false,
      detail:
        "the buyer did not report the transaction id it signed, so the relayed id cannot be corroborated",
    });
  } else {
    const matches = args.transactionIdMatches === true && relayed === signed;
    checks.push({
      name: "payment_id_matches_signed",
      passed: matches,
      detail: matches
        ? `relayed transaction id matches the one the buyer signed (${signed})`
        : `seller relayed ${relayed || "(nothing)"} but the buyer signed ${signed}`,
    });
  }

  if (relayed === "") {
    checks.push({
      name: "payment_confirmed_on_chain",
      passed: false,
      detail: "no transaction id was reported, so no payment could be confirmed",
    });
    return checks;
  }

  const confirmed = await readTransaction(relayed, args.paymentConfirmTimeoutMs);
  if (!confirmed) {
    checks.push({
      name: "payment_confirmed_on_chain",
      passed: false,
      detail: `transaction ${relayed} could not be found on chain, so the payment is unconfirmed`,
    });
  } else {
    const ok = confirmed.result === "SUCCESS";
    checks.push({
      name: "payment_confirmed_on_chain",
      passed: ok,
      detail: ok
        ? `payment confirmed on chain with result SUCCESS at consensus ${confirmed.consensusTimestamp}`
        : `the ledger reports transaction ${relayed} with result ${confirmed.result}`,
    });
    if (ok) checks.push(checkCredit(confirmed, args));
  }
  return checks;
}

/**
 * Confirms the transaction actually credited the seller with the price.
 *
 * Without this, everything above establishes only that *a* transaction with
 * that id reached consensus successfully. It says nothing about who was paid or
 * how much, so any successful transaction on the network would satisfy it,
 * including one that paid a different account, or nothing at all.
 *
 * The transfer list is the ledger's own record of who gained and who lost, so
 * this is checked there rather than against anything a buyer or seller reports.
 *
 * @param confirmed - The transaction as the mirror node returned it
 * @param args - Verification arguments, carrying the expected payee and price
 * @returns A check describing whether the money went where it was supposed to
 */
function checkCredit(confirmed: ConfirmedTransaction, args: VerifyArgs): DeliveryCheck {
  const name = "payment_credited_the_seller";
  const payTo = String(args.payTo ?? "").trim();
  if (!payTo) {
    return { name, passed: false, detail: "no payee was recorded, so the credit cannot be checked" };
  }

  let expected: bigint;
  try {
    expected = toTinybars(args.amountHbar ?? "");
  } catch {
    return {
      name,
      passed: false,
      detail: "no price was recorded, so the amount credited cannot be checked",
    };
  }
  if (expected <= 0n) {
    return { name, passed: false, detail: "the recorded price is not a positive amount" };
  }

  // Sum rather than find: a transaction may credit the same account more than
  // once, and taking the first entry would under-count a legitimate payment.
  //
  // BigInt() throws a RangeError on anything that is not an integer, and
  // `amount` arrives as a JSON number from a third party. checkPayment has no
  // try/catch, so an unexpected value here would take down the verifier rather
  // than produce a verdict. This function is fail-closed; it must fail, not
  // throw.
  let credited: bigint;
  try {
    credited = confirmed.transfers
      .filter((transfer) => transfer.account === payTo)
      .reduce((total, transfer) => total + BigInt(transfer.amount), 0n);
  } catch {
    return {
      name,
      passed: false,
      detail: `the ledger's transfer list for ${confirmed.transactionId} could not be read as whole tinybars, so the credit to ${payTo} is unestablished`,
    };
  }

  if (credited >= expected) {
    return {
      name,
      passed: true,
      detail: `the ledger's transfer list credits ${payTo} with ${formatHbar(toHbar(credited))} HBAR, the price that was advertised`,
    };
  }
  // `credited <= 0n`, not `=== 0n`. A transfer list can leave the payee net
  // negative, and toHbar refuses negative amounts, so the strict-equality
  // version turned a NOT DELIVERED verdict into an uncaught throw with nothing
  // written to HCS. A seller that wanted to escape being attested only had to
  // relay a transaction id in which its own account paid out.
  return {
    name,
    passed: false,
    detail:
      credited <= 0n
        ? `transaction ${confirmed.transactionId} succeeded but credits ${payTo} nothing, so this payment did not pay the seller`
        : `transaction ${confirmed.transactionId} credits ${payTo} with ${formatHbar(toHbar(credited))} HBAR, less than the ${formatHbar(args.amountHbar ?? "0")} HBAR advertised`,
  };
}

/**
 * Verifies whether a paid call actually delivered what was purchased.
 *
 * @param args - The response, what was requested, and the payment context
 * @returns A verdict including every check that was run
 */
export async function verifyDelivery(args: VerifyArgs): Promise<DeliveryVerdict> {
  const identity = await checkIdentityBinding(args.advertisedSellerDid, args.payTo);
  const payment = await checkPayment(args);

  // Re-derive the truth for whatever moment the seller claims to describe, so
  // the comparison is like for like.
  let truth = null;
  try {
    const claimed = JSON.parse(args.rawBody) as { snapshotTimestamp?: unknown };
    const at = typeof claimed.snapshotTimestamp === "string" ? claimed.snapshotTimestamp : undefined;
    truth = await readBalanceSnapshotAt(args.requestedAccount, at);
  } catch {
    truth = null;
  }

  const verdict = checkDelivery({
    rawBody: args.rawBody,
    requestedAccount: args.requestedAccount,
    paidSellerDid: args.advertisedSellerDid,
    truth,
    verifiedAt: args.verifiedAt ?? new Date(),
    maxSnapshotAgeSeconds: args.maxSnapshotAgeSeconds,
  });

  const checks = [...identity, ...payment, ...verdict.checks];
  const failure = checks.find((check) => !check.passed);
  return {
    delivered: !failure,
    reason: failure ? failure.detail : verdict.reason,
    checks,
  };
}
