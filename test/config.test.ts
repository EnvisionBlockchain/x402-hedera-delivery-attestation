/**
 * Config safety. The mainnet guard and the spend cap are the two things
 * standing between a demo and real money.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  caip2Network,
  facilitatorUrl,
  hashscanAccount,
  hashscanBase,
  hashscanTopic,
  hashscanTx,
  isMainnet,
  maxSpendHbar,
  mirrorNodeUrl,
  network,
  networkBanner,
  priceHbar,
} from "../src/config.js";
import { toTinybars } from "../src/hedera/units.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("network", () => {
  // Defaulting to the free network is the safe direction to be wrong in.
  it("defaults to testnet when unset", () => {
    vi.stubEnv("HEDERA_NETWORK", "");
    expect(network()).toBe("testnet");
    expect(isMainnet()).toBe(false);
  });

  it("accepts testnet", () => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    expect(network()).toBe("testnet");
  });

  it("accepts mainnet when it is named explicitly", () => {
    vi.stubEnv("HEDERA_NETWORK", "mainnet");
    expect(network()).toBe("mainnet");
    expect(isMainnet()).toBe(true);
  });

  it("is case insensitive on both networks", () => {
    vi.stubEnv("HEDERA_NETWORK", "TESTNET");
    expect(network()).toBe("testnet");
    vi.stubEnv("HEDERA_NETWORK", "MainNet");
    expect(network()).toBe("mainnet");
  });

  // The most important assertion in this file: a typo must never resolve to a
  // network. Silently defaulting a misspelled "mainnet" to testnet would be
  // just as wrong as the reverse, because the operator would believe the
  // opposite of what is happening.
  it("refuses anything that is neither network, rather than defaulting", () => {
    for (const value of ["previewnet", "local", "custom", "mainet", "test", "main"]) {
      vi.stubEnv("HEDERA_NETWORK", value);
      expect(() => network()).toThrow(/testnet.*mainnet|mainnet.*testnet/i);
    }
  });
});

describe("network-derived endpoints", () => {
  it("point every read and link at the selected network", () => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    expect(mirrorNodeUrl()).toBe("https://testnet.mirrornode.hedera.com");
    expect(hashscanBase()).toBe("https://hashscan.io/testnet");
    expect(caip2Network()).toBe("hedera:testnet");

    vi.stubEnv("HEDERA_NETWORK", "mainnet");
    expect(mirrorNodeUrl()).toBe("https://mainnet.mirrornode.hedera.com");
    expect(hashscanBase()).toBe("https://hashscan.io/mainnet");
    expect(caip2Network()).toBe("hedera:mainnet");
  });

  // A testnet facilitator cannot settle a mainnet transfer. Getting this wrong
  // fails deep inside the payment flow instead of at startup.
  it("defaults the facilitator to one that can actually settle on that network", () => {
    vi.stubEnv("FACILITATOR_URL", "");
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    expect(facilitatorUrl()).toContain("testnet");

    vi.stubEnv("HEDERA_NETWORK", "mainnet");
    expect(facilitatorUrl()).not.toContain("testnet");
  });

  it("lets an explicit facilitator override win on either network", () => {
    vi.stubEnv("FACILITATOR_URL", "https://facilitator.example");
    for (const net of ["testnet", "mainnet"]) {
      vi.stubEnv("HEDERA_NETWORK", net);
      expect(facilitatorUrl()).toBe("https://facilitator.example");
    }
  });

  it("names the network in the banner, and says so loudly on mainnet", () => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    expect(networkBanner()).toContain("hedera:testnet");
    expect(networkBanner()).not.toMatch(/REAL FUNDS/);

    vi.stubEnv("HEDERA_NETWORK", "mainnet");
    expect(networkBanner()).toContain("hedera:mainnet");
    expect(networkBanner()).toMatch(/REAL FUNDS/);
  });

  it("caps mainnet spending tighter than testnet by default", () => {
    vi.stubEnv("MAX_SPEND_HBAR", "");
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    const testnetCap = toTinybars(maxSpendHbar());
    vi.stubEnv("HEDERA_NETWORK", "mainnet");
    expect(toTinybars(maxSpendHbar())).toBeLessThan(testnetCap);
  });

  it("still honours an explicit cap on mainnet", () => {
    vi.stubEnv("HEDERA_NETWORK", "mainnet");
    vi.stubEnv("MAX_SPEND_HBAR", "5");
    expect(maxSpendHbar()).toBe("5");
  });
});

describe("maxSpendHbar", () => {
  it("has a default", () => {
    vi.stubEnv("MAX_SPEND_HBAR", "");
    expect(toTinybars(maxSpendHbar())).toBeGreaterThan(0n);
  });

  it("honours an override", () => {
    vi.stubEnv("MAX_SPEND_HBAR", "1.5");
    expect(maxSpendHbar()).toBe("1.5");
  });

  it("survives a cap whose tinybar value exceeds what a double can hold", () => {
    vi.stubEnv("MAX_SPEND_HBAR", "90071992547.40993");
    expect(toTinybars(maxSpendHbar())).toBe(9007199254740993000n);
  });

  it("rejects a non-numeric cap rather than silently allowing everything", () => {
    vi.stubEnv("MAX_SPEND_HBAR", "lots");
    expect(() => toTinybars(maxSpendHbar())).toThrow();
  });
});

describe("priceHbar", () => {
  it("has a default expressed in HBAR", () => {
    vi.stubEnv("PRICE_HBAR", "");
    expect(priceHbar()).toBe("0.01");
  });

  it("honours an override", () => {
    vi.stubEnv("PRICE_HBAR", "0.25");
    expect(priceHbar()).toBe("0.25");
  });
});

describe("hashscan link builders", () => {
  it("point at testnet by default", () => {
    vi.stubEnv("HEDERA_NETWORK", "");
    expect(hashscanTx("0.0.1@2.3")).toContain("hashscan.io/testnet/transaction/");
    expect(hashscanTopic("0.0.5")).toContain("hashscan.io/testnet/topic/");
    expect(hashscanAccount("0.0.5")).toContain("hashscan.io/testnet/account/");
  });

  it("follow the selected network", () => {
    vi.stubEnv("HEDERA_NETWORK", "mainnet");
    expect(hashscanTx("0.0.1@2.3")).toContain("hashscan.io/mainnet/transaction/");
    expect(hashscanTopic("0.0.5")).toContain("hashscan.io/mainnet/topic/");
    expect(hashscanAccount("0.0.5")).toContain("hashscan.io/mainnet/account/");
  });
});
