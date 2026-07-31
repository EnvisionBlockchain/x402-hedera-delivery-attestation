/**
 * Buyer-side parsing. The advertised DID is what later binds an attestation to
 * a seller identity, so extracting it wrongly silently breaks the trust chain.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseAdvertisedDid, payAndFetch } from "../src/buyer/pay.js";

describe("parseAdvertisedDid", () => {
  it("extracts the DID from a well-formed description", () => {
    expect(
      parseAdvertisedDid("Hedera account snapshot | servedBy=did:hedera:testnet:zabc_0.0.5"),
    ).toBe("did:hedera:testnet:zabc_0.0.5");
  });

  it("stops at whitespace rather than swallowing trailing text", () => {
    expect(parseAdvertisedDid("servedBy=did:hedera:testnet:zabc_0.0.5 and more words")).toBe(
      "did:hedera:testnet:zabc_0.0.5",
    );
  });

  it("returns empty string when no DID is advertised", () => {
    expect(parseAdvertisedDid("Hedera account snapshot")).toBe("");
  });

  it("returns empty string for an undefined description", () => {
    expect(parseAdvertisedDid(undefined)).toBe("");
  });

  it("returns empty string for an empty description", () => {
    expect(parseAdvertisedDid("")).toBe("");
  });

  it("does not match a key that merely ends in the marker", () => {
    expect(parseAdvertisedDid("notservedBy=did:hedera:testnet:zabc_0.0.5")).toBe("");
    expect(parseAdvertisedDid("xservedBy=did:hedera:testnet:zabc_0.0.5")).toBe("");
  });

  it("matches after a pipe separator, which is the format the gate emits", () => {
    expect(parseAdvertisedDid("Hedera account snapshot |servedBy=did:x")).toBe("did:x");
  });

  it("takes the first DID when several are present", () => {
    expect(parseAdvertisedDid("servedBy=did:a | servedBy=did:b")).toBe("did:a");
  });

  it("is case sensitive, so a differently-cased marker does not match", () => {
    expect(parseAdvertisedDid("SERVEDBY=did:x")).toBe("");
  });
});

/**
 * The spend cap must apply to the option actually selected.
 *
 * @x402/core filters advertised options to the supported scheme and network and
 * then selects independently, so accepts[0] is not necessarily what gets paid. A
 * seller listing a cheap unsupported decoy first could therefore get the buyer
 * to sign for an uncapped amount.
 */
describe("payAndFetch spend cap", () => {
  const SELLER_DID = "did:hedera:testnet:zSeller_0.0.5001";
  // Wire amounts stay tinybars because x402 requires atomic units; the buyer
  // reports and caps in HBAR. 50,000,000 tinybars is 0.5 HBAR.
  const DECOY = "1000";
  const REAL = "50000000";

  function response(status: number, body: unknown, headers: Record<string, string> = {}) {
    const text = JSON.stringify(body);
    const res = {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (n: string) => headers[n] ?? headers[n.toLowerCase()] ?? null },
      json: async () => JSON.parse(text),
      text: async () => text,
      clone: () => res,
    };
    return res;
  }

  /** Advertises a cheap decoy first; selects the expensive one, as core would. */
  function client(acceptedAmount: string, asset = "0.0.0") {
    const accepted = {
      scheme: "exact",
      network: "hedera:testnet",
      amount: acceptedAmount,
      asset,
      payTo: "0.0.realseller",
    };
    return {
      getPaymentRequiredResponse: () => ({
        x402Version: 2,
        resource: { description: `snapshot | servedBy=${SELLER_DID}` },
        accepts: [
          { ...accepted, amount: DECOY, payTo: "0.0.decoy", network: "eip155:1" },
          accepted,
        ],
      }),
      handlePaymentRequired: async () => null,
      createPaymentPayload: async () => ({ x402Version: 2, accepted, payload: {} }),
      encodePaymentSignatureHeader: () => ({ "PAYMENT-SIGNATURE": "signed" }),
      getPaymentSettleResponse: () => ({ transaction: "0.0.7162784@1785.1", success: true }),
    } as unknown as Parameters<typeof payAndFetch>[0];
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("refuses when the SELECTED option exceeds the cap, even though the first advertised option is cheap", async () => {
    vi.stubEnv("MAX_SPEND_HBAR", "0.1");
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (...a: unknown[]) => {
      calls.push(a);
      return response(402, { error: "Payment required" });
    }));

    await expect(payAndFetch(client(REAL), "http://x/snapshot")).rejects.toThrow(/cap/i);
    // Nothing was paid: only the unpaid probe went out.
    expect(calls).toHaveLength(1);
  });

  it("names both the refused amount and the cap", async () => {
    vi.stubEnv("MAX_SPEND_HBAR", "0.1");
    vi.stubGlobal("fetch", vi.fn(async () => response(402, {})));
    await expect(payAndFetch(client(REAL), "http://x/snapshot")).rejects.toThrow(/0\.5 HBAR/);
    await expect(payAndFetch(client(REAL), "http://x/snapshot")).rejects.toThrow(/0\.1 HBAR/);
  });

  it("pays when the selected option is within the cap, and records the selected option", async () => {
    vi.stubEnv("MAX_SPEND_HBAR", "0.1");
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n += 1;
      return n === 1
        ? response(402, { error: "Payment required" })
        : response(200, { resource: "hedera-account-snapshot" });
    }));

    const call = await payAndFetch(client("1000000"), "http://x/snapshot");
    expect(call.amountHbar).toBe("0.01");
    // Not the decoy's payee.
    expect(call.payTo).toBe("0.0.realseller");
    expect(call.advertisedSellerDid).toBe(SELLER_DID);
  });

  // The cap counts tinybars. An HTS requirement is denominated in that token's
  // atomic units, so comparing them is comparing two different things: a million
  // units of an 18-decimal token is not 0.01 HBAR. Three documents call this cap
  // the only limit on what an arbitrary endpoint can charge, so a requirement it
  // cannot bound has to be refused rather than waved through.
  //
  // Without this test, deleting the guard leaves the suite green.
  it("refuses a requirement priced in a token rather than HBAR", async () => {
    vi.stubEnv("MAX_SPEND_HBAR", "0.1");
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (...a: unknown[]) => {
      calls.push(a);
      return response(402, { error: "Payment required" });
    }));

    // Well inside the numeric cap. Only the asset makes it unbounded.
    await expect(payAndFetch(client("1000", "0.0.456858"), "http://x/snapshot")).rejects.toThrow(
      /asset 0\.0\.456858/,
    );
    // Refused before anything was transmitted: only the unpaid probe went out.
    expect(calls).toHaveLength(1);
  });

  it("refuses a requirement that names no asset at all", async () => {
    vi.stubEnv("MAX_SPEND_HBAR", "0.1");
    vi.stubGlobal("fetch", vi.fn(async () => response(402, {})));
    await expect(payAndFetch(client("1000", ""), "http://x/snapshot")).rejects.toThrow(
      /unspecified/,
    );
  });

  it("accepts exactly at the cap and refuses one tinybar above", async () => {
    vi.stubEnv("MAX_SPEND_HBAR", "0.00001");
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n += 1;
      return n === 1 ? response(402, {}) : response(200, { ok: true });
    }));
    await expect(payAndFetch(client("1000"), "http://x/snapshot")).resolves.toBeTruthy();

    vi.stubGlobal("fetch", vi.fn(async () => response(402, {})));
    await expect(payAndFetch(client("1001"), "http://x/snapshot")).rejects.toThrow(/cap/i);
  });
});
