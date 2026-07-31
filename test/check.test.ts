/**
 * The delivery checker is the component the entire demo rests on.
 *
 * The central case is `rejects a well-formed response with a fabricated
 * balance`: a shape check passes it, and only independent re-derivation
 * catches it. If that test is wrong, the demo proves nothing.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_SNAPSHOT_AGE_SECONDS,
  checkDelivery,
  type SnapshotTruth,
} from "../src/verifier/check.js";

const ACCOUNT = "0.0.2";
const SELLER_DID = "did:hedera:testnet:zAbC123_0.0.5001";
const SNAPSHOT_TS = "1785349071.906545104";
/** The same instant as SNAPSHOT_TS, so an unmodified record reads as age zero. */
const VERIFIED_AT = new Date(1785349071906);
const DAY = 86_400_000;

const truth: SnapshotTruth = {
  snapshotTimestamp: SNAPSHOT_TS,
  balanceHbar: "34033354182.96113178",
  tokenCount: 0,
};

/** A response that is exactly what was purchased. */
function honestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    resource: "hedera-account-snapshot",
    version: "1",
    account: ACCOUNT,
    snapshotTimestamp: SNAPSHOT_TS,
    balanceHbar: "34033354182.96113178",
    tokenCount: 0,
    sourceMirrorNode: "https://testnet.mirrornode.hedera.com",
    servedBy: SELLER_DID,
    ...overrides,
  });
}

function check(
  rawBody: string,
  truthOverride: SnapshotTruth | null = truth,
  verifiedAt: Date = VERIFIED_AT,
) {
  return checkDelivery({
    rawBody,
    requestedAccount: ACCOUNT,
    paidSellerDid: SELLER_DID,
    truth: truthOverride,
    verifiedAt,
  });
}

describe("checkDelivery", () => {
  it("accepts a response whose values match the mirror node", () => {
    const verdict = check(honestBody());
    expect(verdict.delivered).toBe(true);
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });

  // The central case. A shape-only validator passes this response.
  it("rejects a well-formed response with a fabricated balance", () => {
    const verdict = check(honestBody({ balanceHbar: "9999999999.99999999" }));
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/balance/i);
    // It must fail on the value, not on the shape.
    expect(verdict.checks.find((c) => c.name === "schema_valid")?.passed).toBe(true);
    expect(verdict.checks.find((c) => c.name === "balance_matches")?.passed).toBe(false);
  });

  it("rejects a well-formed response with a fabricated token count", () => {
    const verdict = check(honestBody({ tokenCount: 7 }));
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/token/i);
    expect(verdict.checks.find((c) => c.name === "schema_valid")?.passed).toBe(true);
  });

  it("rejects a snapshot for a different account than the one requested", () => {
    const verdict = check(honestBody({ account: "0.0.98" }));
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/account/i);
  });

  it("rejects a response served by a DID other than the seller that was paid", () => {
    const verdict = check(honestBody({ servedBy: "did:hedera:testnet:zOther_0.0.9999" }));
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/served|identity|did/i);
  });

  it("rejects a snapshot timestamp that does not match the verified snapshot", () => {
    const verdict = check(honestBody({ snapshotTimestamp: "1700000000.000000000" }));
    expect(verdict.delivered).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(check("").delivered).toBe(false);
  });

  it("rejects a JSON error object", () => {
    const verdict = check(JSON.stringify({ error: "upstream unavailable" }));
    expect(verdict.delivered).toBe(false);
    expect(verdict.checks.find((c) => c.name === "schema_valid")?.passed).toBe(false);
  });

  it("rejects a plausible 200 that is not the purchased resource", () => {
    const verdict = check(JSON.stringify({ status: "ok", message: "Request processed" }));
    expect(verdict.delivered).toBe(false);
  });

  it("rejects malformed JSON without throwing", () => {
    expect(() => check("{not json")).not.toThrow();
    expect(check("{not json").delivered).toBe(false);
  });

  it("rejects when the verifier could not independently establish the truth", () => {
    const verdict = check(honestBody(), null);
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/independent|verify|mirror/i);
  });

  it("reports every check it ran, so a verdict is auditable", () => {
    const verdict = check(honestBody());
    const names = verdict.checks.map((c) => c.name);
    expect(names).toContain("body_parses");
    expect(names).toContain("schema_valid");
    expect(names).toContain("account_matches");
    expect(names).toContain("served_by_matches");
    expect(names).toContain("balance_matches");
    expect(names).toContain("token_count_matches");
  });
});

/**
 * Staleness. A seller can return a real snapshot from hours ago: every value
 * matches the mirror node, so without an age bound the verdict is DELIVERED and
 * the buyer paid for data that describes the wrong moment.
 *
 * The bound has to be generous. Snapshots land roughly every 901 seconds and the
 * mirror node answers with the most recent one at or before the request, so an
 * honest seller legitimately holds a snapshot most of an interval old.
 */
describe("checkDelivery freshness", () => {
  it("accepts a snapshot taken at verification time", () => {
    expect(check(honestBody()).delivered).toBe(true);
  });

  // The case the whole check exists for.
  it("rejects a genuine snapshot from a day ago", () => {
    const verdict = check(honestBody(), truth, new Date(VERIFIED_AT.getTime() + DAY));
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/stale|old|age/i);
    // It must fail on age alone, with every value still matching.
    expect(verdict.checks.find((c) => c.name === "balance_matches")?.passed).toBe(true);
    expect(verdict.checks.find((c) => c.name === "snapshot_is_fresh")?.passed).toBe(false);
  });

  it("reports the observed age, not just that it is too old", () => {
    const verdict = check(honestBody(), truth, new Date(VERIFIED_AT.getTime() + DAY));
    const fresh = verdict.checks.find((c) => c.name === "snapshot_is_fresh");
    expect(fresh?.detail).toMatch(/86400|86,400|\b24\b|day/i);
  });

  // The honest-seller case the tolerance protects: older than one snapshot
  // interval, still well inside the bound.
  it("accepts a snapshot older than one interval but inside the bound", () => {
    const verdict = check(honestBody(), truth, new Date(VERIFIED_AT.getTime() + 1000 * 1000));
    expect(verdict.delivered).toBe(true);
  });

  it("is inclusive at the bound and rejects just past it", () => {
    const bound = MAX_SNAPSHOT_AGE_SECONDS * 1000;
    expect(check(honestBody(), truth, new Date(VERIFIED_AT.getTime() + bound)).delivered).toBe(true);
    expect(
      check(honestBody(), truth, new Date(VERIFIED_AT.getTime() + bound + 1000)).delivered,
    ).toBe(false);
  });

  it("rejects a snapshot dated in the future", () => {
    const verdict = check(honestBody(), truth, new Date(VERIFIED_AT.getTime() - DAY));
    expect(verdict.delivered).toBe(false);
    expect(verdict.checks.find((c) => c.name === "snapshot_is_fresh")?.passed).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["not a number", "yesterday"],
    ["partial", "1785349071."],
  ])("rejects an unparseable snapshot timestamp (%s) rather than treating it as age zero", (_l, ts) => {
    const verdict = check(honestBody({ snapshotTimestamp: ts }), {
      ...truth,
      snapshotTimestamp: ts,
    });
    expect(verdict.delivered).toBe(false);
  });

  it("names the freshness check in the reported checks for an honest record", () => {
    expect(check(honestBody()).checks.map((c) => c.name)).toContain("snapshot_is_fresh");
  });

  it("runs freshness before the value comparisons, so staleness owns the reason", () => {
    const verdict = check(
      honestBody({ balanceTinybars: "1" }),
      truth,
      new Date(VERIFIED_AT.getTime() + DAY),
    );
    expect(verdict.reason).toMatch(/stale|old|age/i);
  });
});
