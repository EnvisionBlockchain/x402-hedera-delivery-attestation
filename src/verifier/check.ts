/**
 * Delivery checking.
 *
 * The thesis of this demo lives here. A seller can take payment and return
 * HTTP 200 with a body that is the right *shape* and still not be the thing
 * that was purchased. Shape validation cannot tell the difference; only
 * re-deriving the answer from an independent source can.
 *
 * So this module never concludes "delivered" from structure alone. It compares
 * the returned values against a snapshot the verifier fetched itself, directly
 * from the Hedera mirror node, without asking the seller for anything.
 */
import { z } from "zod";

import { formatHbar } from "../hedera/units.js";

/** The resource a seller is paid to produce. */
export const SnapshotRecordSchema = z.object({
  resource: z.literal("hedera-account-snapshot"),
  version: z.string().min(1),
  account: z.string().min(1),
  snapshotTimestamp: z.string().min(1),
  balanceHbar: z.string().min(1),
  tokenCount: z.number().int().nonnegative(),
  sourceMirrorNode: z.string().min(1),
  servedBy: z.string().min(1),
});

export type SnapshotRecord = z.infer<typeof SnapshotRecordSchema>;

/**
 * What the verifier independently established to be true.
 *
 * Hedera balance snapshots are immutable historical records, so this is
 * reproducible by any third party at any later date. That is what makes an
 * attestation about it worth anything.
 */
export type SnapshotTruth = {
  readonly snapshotTimestamp: string;
  readonly balanceHbar: string;
  readonly tokenCount: number;
};

export type DeliveryCheck = {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
};

export type DeliveryVerdict = {
  readonly delivered: boolean;
  readonly reason: string;
  readonly checks: readonly DeliveryCheck[];
};

/**
 * How stale a purchased snapshot may be before it stops counting as delivered.
 *
 * Two snapshot intervals. Measured cadence on testnet is 901 seconds, and the
 * mirror node answers a balance query with the most recent snapshot at or
 * before the requested time, so an honest seller asking for "now" legitimately
 * receives one nearly a full interval old. A one-interval bound would therefore
 * fail honest sellers about half the time.
 *
 * The honest reading of this number: it bounds staleness to roughly half an
 * hour. It does not make the data real-time, and the README says so.
 */
export const MAX_SNAPSHOT_AGE_SECONDS = 1800;

export type CheckDeliveryArgs = {
  /** Exactly the bytes the seller returned. */
  readonly rawBody: string;
  /** The account the buyer asked about. */
  readonly requestedAccount: string;
  /** The DID of the seller that actually received the payment. */
  readonly paidSellerDid: string;
  /** What the verifier established on its own, or null if it could not. */
  readonly truth: SnapshotTruth | null;
  /**
   * The verifier's own clock. Never a seller-supplied value, which would make
   * the freshness check circular.
   */
  readonly verifiedAt?: Date;
  /** Override for the staleness bound. Tests pin it; production uses the default. */
  readonly maxSnapshotAgeSeconds?: number;
};

/**
 * Converts a Hedera consensus timestamp to epoch milliseconds.
 *
 * Format is `seconds.nanoseconds`. Returns null rather than a number for
 * anything that does not match, so an unparseable value fails the freshness
 * check instead of silently reading as age zero.
 *
 * @param timestamp - Consensus timestamp string
 * @returns Epoch milliseconds, or null when unparseable
 */
export function consensusTimestampToMillis(timestamp: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(timestamp.trim());
  if (!match) return null;
  const seconds = Number(match[1]);
  const nanos = Number((match[2] ?? "0").padEnd(9, "0"));
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

/**
 * Decides whether a response is the resource that was purchased.
 *
 * Pure and synchronous: all network work happens in `verifyDelivery`, so the
 * decision logic is exhaustively testable against fixtures.
 *
 * @param args - The response, what was requested, who was paid, and the
 *               independently established truth
 * @returns A verdict, plus every check that was run so it can be audited
 */
export function checkDelivery(args: CheckDeliveryArgs): DeliveryVerdict {
  const { rawBody, requestedAccount, paidSellerDid, truth } = args;
  const checks: DeliveryCheck[] = [];
  const add = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };

  // 1. Is it even JSON?
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
    add("body_parses", true, "response body is valid JSON");
  } catch {
    add("body_parses", false, "response body is not valid JSON");
    return verdict(checks);
  }

  // 2. Is it the advertised resource, structurally?
  const result = SnapshotRecordSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    add(
      "schema_valid",
      false,
      `response is not a hedera-account-snapshot record: ${
        issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "shape mismatch"
      }`,
    );
    return verdict(checks);
  }
  const record = result.data;
  add("schema_valid", true, "response matches the advertised resource shape");

  // 3. Is it about the thing that was asked for?
  add(
    "account_matches",
    record.account === requestedAccount,
    record.account === requestedAccount
      ? `snapshot is for the requested account ${requestedAccount}`
      : `snapshot is for account ${record.account}, but ${requestedAccount} was requested`,
  );

  // 4. Did it come from the identity that was paid?
  add(
    "served_by_matches",
    record.servedBy === paidSellerDid,
    record.servedBy === paidSellerDid
      ? "served by the DID that received the payment"
      : `served by ${record.servedBy}, but payment went to ${paidSellerDid}`,
  );

  // 5..7 need an independent source. Without one there is no verdict to give.
  if (!truth) {
    add(
      "independent_truth_available",
      false,
      "the verifier could not reach the mirror node to independently verify this claim",
    );
    return verdict(checks);
  }
  add("independent_truth_available", true, "verifier independently queried the mirror node");

  // Staleness. Every value below can match perfectly while describing the wrong
  // moment, so age is checked before the comparisons and owns the reason when it
  // fails.
  const maxAge = args.maxSnapshotAgeSeconds ?? MAX_SNAPSHOT_AGE_SECONDS;
  const snapshotMillis = consensusTimestampToMillis(record.snapshotTimestamp);
  if (snapshotMillis === null) {
    add(
      "snapshot_is_fresh",
      false,
      `snapshot timestamp "${record.snapshotTimestamp}" is not a Hedera consensus timestamp, so its age cannot be established`,
    );
  } else {
    const ageSeconds = ((args.verifiedAt ?? new Date()).getTime() - snapshotMillis) / 1000;
    if (ageSeconds < 0) {
      add(
        "snapshot_is_fresh",
        false,
        `snapshot is dated ${Math.abs(ageSeconds).toFixed(0)}s in the future, which cannot be genuine`,
      );
    } else {
      add(
        "snapshot_is_fresh",
        ageSeconds <= maxAge,
        ageSeconds <= maxAge
          ? `snapshot is ${ageSeconds.toFixed(0)}s old, inside the ${maxAge}s bound`
          : `snapshot is stale: ${ageSeconds.toFixed(0)}s old, bound is ${maxAge}s`,
      );
    }
  }

  const timestampMatches = record.snapshotTimestamp === truth.snapshotTimestamp;
  add(
    "snapshot_timestamp_matches",
    timestampMatches,
    timestampMatches
      ? `snapshot timestamp ${record.snapshotTimestamp} confirmed`
      : `claimed snapshot at ${record.snapshotTimestamp}, but the mirror node's snapshot is ${truth.snapshotTimestamp}`,
  );

  const balanceMatches = record.balanceHbar === truth.balanceHbar;
  add(
    "balance_matches",
    balanceMatches,
    balanceMatches
      ? `balance ${formatHbar(record.balanceHbar)} HBAR confirmed independently`
      : `claimed balance ${formatHbar(record.balanceHbar)} HBAR, mirror node reports ${formatHbar(truth.balanceHbar)} HBAR`,
  );

  const tokensMatch = record.tokenCount === truth.tokenCount;
  add(
    "token_count_matches",
    tokensMatch,
    tokensMatch
      ? `token count ${record.tokenCount} confirmed independently`
      : `claimed token count ${record.tokenCount}, mirror node reports ${truth.tokenCount}`,
  );

  return verdict(checks);
}

function verdict(checks: DeliveryCheck[]): DeliveryVerdict {
  const failure = checks.find((check) => !check.passed);
  return {
    delivered: !failure,
    reason: failure ? failure.detail : "the resource that was paid for was delivered",
    checks,
  };
}
