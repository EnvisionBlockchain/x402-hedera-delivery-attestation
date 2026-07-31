/**
 * The contract between what a seller produces and what the verifier accepts.
 *
 * Every other test checks one side in isolation. These check that the two
 * agree: the honest seller's output must pass the checker, and the dishonest
 * seller's must fail it. If this file goes green while the demo is broken,
 * nothing else would notice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildFabricatedRecord } from "../src/seller/dishonest.js";
import { buildSnapshotRecord } from "../src/seller/honest.js";
import { toHbar } from "../src/hedera/units.js";
import { checkDelivery, type SnapshotTruth } from "../src/verifier/check.js";

const ACCOUNT = "0.0.2";
const SELLER_DID = "did:hedera:testnet:zSeller_0.0.5001";
const SNAPSHOT_TS = "1785349071.906545104";
/** Same instant as SNAPSHOT_TS, so the fixture is not stale against a live clock. */
const VERIFIED_AT = new Date(1785349071906);
const REAL_BALANCE = 3403307618892155400;

const truth: SnapshotTruth = {
  snapshotTimestamp: SNAPSHOT_TS,
  balanceHbar: toHbar(String(REAL_BALANCE)),
  tokenCount: 0,
};

function mockMirror(balance = REAL_BALANCE, tokens: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string) => {
      const payload = `{"timestamp":"${SNAPSHOT_TS}","balances":[{"balance":${balance},"tokens":${JSON.stringify(
        tokens,
      )}}]}`;
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(payload),
        text: async () => payload,
      };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("honest seller output", () => {
  it("passes the delivery check", async () => {
    mockMirror();
    const record = await buildSnapshotRecord(ACCOUNT, SELLER_DID);
    const verdict = checkDelivery({
      rawBody: JSON.stringify(record),
      requestedAccount: ACCOUNT,
      paidSellerDid: SELLER_DID,
      truth,
      verifiedAt: VERIFIED_AT,
    });
    expect(verdict.delivered).toBe(true);
  });

  it("reports the account it was asked about", async () => {
    mockMirror();
    expect((await buildSnapshotRecord(ACCOUNT, SELLER_DID)).account).toBe(ACCOUNT);
  });

  it("reports its own DID truthfully", async () => {
    mockMirror();
    expect((await buildSnapshotRecord(ACCOUNT, SELLER_DID)).servedBy).toBe(SELLER_DID);
  });

  it("declares the advertised resource type", async () => {
    mockMirror();
    expect((await buildSnapshotRecord(ACCOUNT, SELLER_DID)).resource).toBe(
      "hedera-account-snapshot",
    );
  });
});

describe("dishonest seller output", () => {
  it("fails the delivery check", async () => {
    mockMirror();
    const record = await buildFabricatedRecord(ACCOUNT, SELLER_DID);
    const verdict = checkDelivery({
      rawBody: JSON.stringify(record),
      requestedAccount: ACCOUNT,
      paidSellerDid: SELLER_DID,
      truth,
      verifiedAt: VERIFIED_AT,
    });
    expect(verdict.delivered).toBe(false);
  });

  // The demo's whole argument: it is caught on values, never on shape.
  it("is caught on values, not on structure or identity", async () => {
    mockMirror();
    const record = await buildFabricatedRecord(ACCOUNT, SELLER_DID);
    const verdict = checkDelivery({
      rawBody: JSON.stringify(record),
      requestedAccount: ACCOUNT,
      paidSellerDid: SELLER_DID,
      truth,
      verifiedAt: VERIFIED_AT,
    });
    const byName = Object.fromEntries(verdict.checks.map((c) => [c.name, c.passed]));
    expect(byName.schema_valid).toBe(true);
    expect(byName.account_matches).toBe(true);
    expect(byName.served_by_matches).toBe(true);
    expect(byName.snapshot_timestamp_matches).toBe(true);
    expect(byName.balance_matches).toBe(false);
  });

  it("produces a record that is structurally indistinguishable from the honest one", async () => {
    mockMirror();
    const honest = await buildSnapshotRecord(ACCOUNT, SELLER_DID);
    const fake = await buildFabricatedRecord(ACCOUNT, SELLER_DID);
    expect(Object.keys(fake).sort()).toEqual(Object.keys(honest).sort());
    expect(typeof fake.balanceTinybars).toBe(typeof honest.balanceTinybars);
    expect(typeof fake.tokenCount).toBe(typeof honest.tokenCount);
  });

  it("fails for a range of real balances, not just one", async () => {
    for (const balance of [0, 1, 141400, 999, 3403307618892155400]) {
      mockMirror(balance);
      const record = await buildFabricatedRecord(ACCOUNT, SELLER_DID);
      const verdict = checkDelivery({
        rawBody: JSON.stringify(record),
        requestedAccount: ACCOUNT,
        paidSellerDid: SELLER_DID,
        truth: { snapshotTimestamp: SNAPSHOT_TS, balanceHbar: toHbar(String(balance)), tokenCount: 0 },
        verifiedAt: VERIFIED_AT,
      });
      expect(verdict.delivered, `balance ${balance} should not pass`).toBe(false);
    }
  });
});
