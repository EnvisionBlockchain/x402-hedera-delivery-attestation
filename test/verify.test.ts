/**
 * The identity binding check.
 *
 * Without it, a seller could advertise a reputable DID while taking payment to
 * an account that identity has nothing to do with, and every attestation would
 * credit or blame the wrong party. These are the cases that must fail.
 */
import { PrivateKey } from "@hiero-ledger/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyDelivery } from "../src/verifier/verify.js";
import { createEnvelope, identity, topicMessagesBody } from "./helpers/did.js";

// The DID commits to its own root key, so a fixture cannot invent a DID string
// and a key independently: resolution treats any document whose key does not
// regenerate the DID as a forgery. Deriving both from one generated key is what
// bootstrap does on the ledger.
const SELLER_KEY = PrivateKey.generateED25519();
const SELLER = identity(SELLER_KEY);
const SELLER_DID = SELLER.did;
const PAID_ACCOUNT = "0.0.9832130";
const ACCOUNT = "0.0.2";
const SNAPSHOT_TS = "1785349071.906545104";
/** Same instant as SNAPSHOT_TS, so the fixture is not stale against a live clock. */
const VERIFIED_AT = new Date(1785349071906);
const REAL_BALANCE = "3403307618892155400";
const REAL_BALANCE_HBAR = "34033076188.921554";
const TX_ID = "0.0.7162784@1785359933.051441057";
const PRICE_HBAR = "0.01";
const PRICE_TINYBARS = 1_000_000;

/** The genuine create event for the seller's identity. */
const SELLER_ENVELOPE = createEnvelope({
  signingKey: SELLER_KEY,
  did: SELLER_DID,
  publishedMultibase: SELLER.multibase,
});

/**
 * Serves the DID topic, the account record, the balance endpoint and the
 * transaction, so verifyDelivery runs its real code path against controlled
 * data.
 *
 * `accountKey` is what the ledger reports as controlling the paid account. It
 * defaults to the seller's own root key, which is the honest case: one key for
 * both the identity and the money.
 */
function mockNetwork(options: {
  didDoc?: string | null;
  accountKey?: string | null;
  balance?: string;
  txResult?: string;
  /** The ledger's transfer list. Defaults to a genuine payment of the price. */
  transfers?: Array<{ account: string; amount: number }>;
}) {
  const envelope = options.didDoc === undefined ? SELLER_ENVELOPE : options.didDoc;
  const accountKey = options.accountKey === undefined ? SELLER.raw : options.accountKey;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes("/topics/")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => topicMessagesBody(envelope === null ? [] : [envelope]),
        };
      }
      if (target.includes("/accounts/")) {
        return {
          ok: true,
          status: 200,
          json: async () =>
            accountKey === null
              ? { account: PAID_ACCOUNT }
              : { account: PAID_ACCOUNT, key: { _type: "ED25519", key: accountKey } },
        };
      }
      if (target.includes("/balances")) {
        const payload = `{"timestamp":"${SNAPSHOT_TS}","balances":[{"balance":${
          options.balance ?? REAL_BALANCE
        },"tokens":[]}]}`;
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(payload),
          text: async () => payload,
        };
      }
      if (target.includes("/transactions/")) {
        const payload = JSON.stringify({
          transactions: [
            {
              transaction_id: TX_ID,
              result: options.txResult ?? "SUCCESS",
              consensus_timestamp: SNAPSHOT_TS,
              charged_tx_fee: 296864,
              transfers: options.transfers ?? [
                { account: "0.0.9929", amount: -PRICE_TINYBARS },
                { account: PAID_ACCOUNT, amount: PRICE_TINYBARS },
              ],
            },
          ],
        });
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(payload),
          text: async () => payload,
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    }),
  );
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    resource: "hedera-account-snapshot",
    version: "1",
    account: ACCOUNT,
    snapshotTimestamp: SNAPSHOT_TS,
    balanceHbar: REAL_BALANCE_HBAR,
    tokenCount: 0,
    sourceMirrorNode: "https://testnet.mirrornode.hedera.com",
    servedBy: SELLER_DID,
    ...overrides,
  });
}

function run(rawBody: string, advertisedSellerDid = SELLER_DID, payTo = PAID_ACCOUNT) {
  return verifyDelivery({
    rawBody,
    requestedAccount: ACCOUNT,
    advertisedSellerDid,
    payTo,
    verifiedAt: VERIFIED_AT,
    paymentTxId: TX_ID,
    signedTransactionId: TX_ID,
    transactionIdMatches: true,
    amountHbar: PRICE_HBAR,
    paymentConfirmTimeoutMs: 0,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyDelivery", () => {
  it("accepts an honest response from a correctly bound identity", async () => {
    mockNetwork({});
    const verdict = await run(body());
    expect(verdict.delivered).toBe(true);
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });

  it("runs the identity check first, so it owns the reason when it fails", async () => {
    mockNetwork({});
    const verdict = await run(body());
    expect(verdict.checks[0]?.name).toBe("seller_identity_resolves");
  });

  // THE IMPERSONATION CASE.
  //
  // A seller advertises a real, resolvable, reputable DID and asks to be paid
  // into an account that identity does not control. The DID resolves perfectly
  // and nothing in its document is false. What gives it away is the ledger: the
  // account that took the money is controlled by some other key.
  it("rejects when the ledger says another key controls the account that was paid", async () => {
    const stranger = PrivateKey.generateED25519().publicKey.toStringRaw();
    mockNetwork({ accountKey: stranger });
    const verdict = await run(body());
    expect(verdict.delivered).toBe(false);
    expect(verdict.checks.find((c) => c.name === "seller_identity_resolves")?.passed).toBe(true);
    expect(
      verdict.checks.find((c) => c.name === "seller_identity_controls_paid_account")?.passed,
    ).toBe(false);
    expect(verdict.reason).toContain(stranger);
  });

  // An ECDSA account cannot share a key with a did:hedera identity, so a DID
  // claiming one is making an unprovable claim. Unprovable fails.
  it("rejects when the paid account is not an ED25519 account at all", async () => {
    mockNetwork({ accountKey: null });
    const verdict = await run(body());
    expect(verdict.delivered).toBe(false);
    expect(
      verdict.checks.find((c) => c.name === "seller_identity_controls_paid_account")?.passed,
    ).toBe(false);
  });

  it("rejects when the advertised DID does not resolve", async () => {
    mockNetwork({ didDoc: null });
    const verdict = await run(body());
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/could not be resolved/i);
  });

  it("rejects when no DID was advertised at all", async () => {
    mockNetwork({});
    const verdict = await run(body(), "");
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/no DID/i);
  });

  // The topic carries no submit key, so an attacker can append a correctly
  // self-signed create event claiming this DID under their own key. Resolution
  // must refuse it rather than hand the verifier the attacker's key.
  it("rejects a published document that rebinds the DID to another key", async () => {
    const attacker = PrivateKey.generateED25519();
    mockNetwork({
      didDoc: createEnvelope({
        signingKey: attacker,
        did: SELLER_DID,
        publishedMultibase: identity(attacker).multibase,
      }),
    });
    const verdict = await run(body());
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/could not be resolved|does not commit/i);
  });

  it("rejects fabricated values even when identity is perfectly bound", async () => {
    mockNetwork({});
    const verdict = await run(body({ balanceHbar: "1" }));
    expect(verdict.delivered).toBe(false);
    expect(verdict.checks.find((c) => c.name === "seller_identity_resolves")?.passed).toBe(true);
    expect(verdict.checks.find((c) => c.name === "balance_matches")?.passed).toBe(false);
  });

  it("re-derives truth at the timestamp the seller claimed, not at now", async () => {
    const spy = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes("/topics/")) {
        return { ok: true, status: 200, statusText: "OK", json: async () => topicMessagesBody([SELLER_ENVELOPE]) };
      }
      if (target.includes("/accounts/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ account: PAID_ACCOUNT, key: { _type: "ED25519", key: SELLER.raw } }),
        };
      }
      const payload = `{"timestamp":"${SNAPSHOT_TS}","balances":[{"balance":1,"tokens":[]}]}`;
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(payload),
        text: async () => payload,
      };
    });
    vi.stubGlobal("fetch", spy);
    await run(body());
    const balanceCall = spy.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/balances"));
    expect(balanceCall).toContain(`timestamp=${SNAPSHOT_TS}`);
  });

  it("does not deliver when the mirror node is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/topics/")) {
          return { ok: true, status: 200, statusText: "OK", json: async () => topicMessagesBody([SELLER_ENVELOPE]) };
        }
        return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
      }),
    );
    const verdict = await run(body());
    expect(verdict.delivered).toBe(false);
    // Payment confirmation now runs before the balance read, so with the whole
    // mirror node down it is the first network-dependent check to fail. The
    // point of the case is that an unreachable source fails closed, whichever
    // check reports it.
    expect(verdict.reason).toMatch(/unconfirmed|could not be found|independently|mirror node could not be asked/i);
    expect(verdict.checks.some((c) => !c.passed)).toBe(true);
  });

  it("does not throw on malformed response bodies", async () => {
    mockNetwork({});
    await expect(run("{not json")).resolves.toMatchObject({ delivered: false });
  });
});

/**
 * The payment the attestation is about. The transaction id arrives from a
 * seller-relayed header and gets signed into a permanent record, so both its
 * provenance and its on-chain fate need establishing independently.
 */
describe("verifyDelivery payment confirmation", () => {
  function run(overrides: Partial<Parameters<typeof verifyDelivery>[0]> = {}) {
    return verifyDelivery({
      rawBody: body(),
      requestedAccount: ACCOUNT,
      advertisedSellerDid: SELLER_DID,
      payTo: PAID_ACCOUNT,
      verifiedAt: VERIFIED_AT,
      paymentTxId: TX_ID,
      signedTransactionId: TX_ID,
      transactionIdMatches: true,
      amountHbar: PRICE_HBAR,
      paymentConfirmTimeoutMs: 0,
      ...overrides,
    });
  }

  it("passes when the ledger reports SUCCESS", async () => {
    mockNetwork({});
    const verdict = await run();
    expect(verdict.delivered).toBe(true);
    expect(verdict.checks.find((c) => c.name === "payment_confirmed_on_chain")?.passed).toBe(true);
  });

  it("rejects a payment the ledger reports as failed", async () => {
    mockNetwork({ txResult: "INSUFFICIENT_PAYER_BALANCE" });
    const verdict = await run();
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/INSUFFICIENT_PAYER_BALANCE/);
  });

  // The provenance gap: the id came from the seller, not from the buyer.
  it("rejects when the relayed id differs from the one the buyer signed", async () => {
    mockNetwork({});
    const verdict = await run({
      signedTransactionId: "0.0.7162784@1785359999.000000001",
      transactionIdMatches: false,
    });
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/relayed[\s\S]*signed|signed[\s\S]*relayed/i);
  });

  it("rejects when the buyer reported no signed id, so the relayed id is uncorroborated", async () => {
    mockNetwork({});
    const verdict = await run({ signedTransactionId: "", transactionIdMatches: false });
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/corroborat/i);
  });

  it("rejects when no transaction id was reported at all", async () => {
    mockNetwork({});
    const verdict = await run({ paymentTxId: "", signedTransactionId: "" });
    expect(verdict.delivered).toBe(false);
  });

  it("rejects a malformed transaction id without reaching the network for it", async () => {
    mockNetwork({});
    const verdict = await run({ paymentTxId: "not-a-tx", signedTransactionId: "not-a-tx" });
    expect(verdict.delivered).toBe(false);
    expect(verdict.checks.find((c) => c.name === "payment_confirmed_on_chain")?.passed).toBe(false);
  });

  it("fails closed when the transaction cannot be found in the wait window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const target = String(url);
        if (target.includes("/topics/")) {
          return { ok: true, status: 200, statusText: "OK", json: async () => topicMessagesBody([SELLER_ENVELOPE]) };
        }
        if (target.includes("/accounts/")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ account: PAID_ACCOUNT, key: { _type: "ED25519", key: SELLER.raw } }),
          };
        }
        if (target.includes("/transactions/")) {
          return { ok: true, status: 200, json: async () => ({ transactions: [] }) };
        }
        const payload = `{"timestamp":"${SNAPSHOT_TS}","balances":[{"balance":${REAL_BALANCE},"tokens":[]}]}`;
        return { ok: true, status: 200, json: async () => JSON.parse(payload), text: async () => payload };
      }),
    );
    const verdict = await run();
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/could not be found|unconfirmed/i);
  });

  it("reports the payment checks by name so the verdict stays auditable", async () => {
    mockNetwork({});
    const names = (await run()).checks.map((c) => c.name);
    expect(names).toContain("payment_id_matches_signed");
    expect(names).toContain("payment_confirmed_on_chain");
    expect(names).toContain("payment_credited_the_seller");
  });

  // THE GAP THIS CLOSES.
  //
  // "The transaction succeeded" and "the seller was paid" are different claims,
  // and for a long time only the first was checked. Any successful transaction
  // on the whole network satisfied the first one, so an attestation could be
  // minted against a payment that went somewhere else, or nowhere.
  it("rejects a successful transaction that credits the seller nothing", async () => {
    mockNetwork({ transfers: [] });
    const verdict = await run();
    expect(verdict.delivered).toBe(false);
    expect(verdict.checks.find((c) => c.name === "payment_confirmed_on_chain")?.passed).toBe(true);
    expect(verdict.checks.find((c) => c.name === "payment_credited_the_seller")?.passed).toBe(false);
    expect(verdict.reason).toMatch(/credits 0\.0\.9832130 nothing/);
  });

  // The version with a plausible cover story: real money moved, to the wrong
  // account. The transfer list is the only place that shows it.
  it("rejects a payment that credited a different account", async () => {
    mockNetwork({
      transfers: [
        { account: "0.0.9929", amount: -PRICE_TINYBARS },
        { account: "0.0.7777777", amount: PRICE_TINYBARS },
      ],
    });
    const verdict = await run();
    expect(verdict.delivered).toBe(false);
    expect(
      verdict.checks.find((c) => c.name === "payment_credited_the_seller")?.passed,
    ).toBe(false);
  });

  it("rejects a payment for less than the advertised price", async () => {
    mockNetwork({
      transfers: [
        { account: "0.0.9929", amount: -1 },
        { account: PAID_ACCOUNT, amount: 1 },
      ],
    });
    const verdict = await run();
    expect(verdict.delivered).toBe(false);
    expect(verdict.reason).toMatch(/less than the/);
  });

  // Overpaying is not fraud against the buyer, and refusing it would fail an
  // honest seller whose price moved between the 402 and settlement.
  it("accepts a payment for more than the advertised price", async () => {
    mockNetwork({
      transfers: [
        { account: "0.0.9929", amount: -PRICE_TINYBARS * 2 },
        { account: PAID_ACCOUNT, amount: PRICE_TINYBARS * 2 },
      ],
    });
    expect((await run()).delivered).toBe(true);
  });

  // Hedera may split a credit across several entries in one transaction.
  it("sums multiple credits to the same account", async () => {
    mockNetwork({
      transfers: [
        { account: "0.0.9929", amount: -PRICE_TINYBARS },
        { account: PAID_ACCOUNT, amount: PRICE_TINYBARS / 2 },
        { account: PAID_ACCOUNT, amount: PRICE_TINYBARS / 2 },
      ],
    });
    expect((await run()).delivered).toBe(true);
  });

  // A seller wanting to escape being attested only had to relay a transaction id
  // in which its own account net-paid. `toHbar` refuses negative amounts, so the
  // strict `credited === 0n` guard turned a NOT DELIVERED verdict into an
  // uncaught throw, with nothing written to HCS at all.
  it("returns a verdict, not a crash, when the payee is net negative", async () => {
    mockNetwork({
      transfers: [
        { account: PAID_ACCOUNT, amount: -PRICE_TINYBARS },
        { account: "0.0.7777777", amount: PRICE_TINYBARS },
      ],
    });
    const verdict = await run();
    expect(verdict.delivered).toBe(false);
    expect(
      verdict.checks.find((c) => c.name === "payment_credited_the_seller")?.passed,
    ).toBe(false);
    expect(verdict.reason).toMatch(/credits 0\.0\.9832130 nothing/);
  });

  // checkPayment has no try/catch, and BigInt() throws a RangeError on anything
  // that is not an integer. `amount` arrives as a JSON number from a third
  // party, so an unexpected value would have taken down the verifier instead of
  // producing a verdict. This function is fail-closed: it must fail, not throw.
  it("returns a verdict, not a crash, when a transfer amount is not a whole number", async () => {
    mockNetwork({
      transfers: [
        { account: "0.0.9929", amount: -PRICE_TINYBARS },
        { account: PAID_ACCOUNT, amount: 1.5 },
      ],
    });
    const verdict = await run();
    expect(verdict.delivered).toBe(false);
    expect(
      verdict.checks.find((c) => c.name === "payment_credited_the_seller")?.passed,
    ).toBe(false);
    expect(verdict.reason).toMatch(/could not be read as whole tinybars/);
  });

  it("fails closed when no price was recorded, rather than skipping the check", async () => {
    mockNetwork({});
    const verdict = await run({ amountHbar: undefined });
    expect(verdict.delivered).toBe(false);
    expect(
      verdict.checks.find((c) => c.name === "payment_credited_the_seller")?.passed,
    ).toBe(false);
  });
});
