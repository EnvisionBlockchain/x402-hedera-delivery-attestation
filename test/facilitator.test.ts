/**
 * Facilitator / network coherence.
 *
 * A facilitator that cannot settle on the configured network is the one
 * misconfiguration that survives every other check: the keys are valid, the
 * accounts exist, the price is right, and settlement fails anyway. This runs
 * before anything is signed, so it has to fail closed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertFacilitatorMatchesNetwork, supportedNetworks } from "../src/facilitator.js";

const TESTNET_KINDS = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "eip155:80002" },
    { x402Version: 2, scheme: "exact", network: "hedera:testnet" },
  ],
};
const MAINNET_KINDS = {
  kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:mainnet" }],
};

function mockFacilitator(body: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("supportedNetworks", () => {
  it("lists the CAIP-2 networks a facilitator advertises", async () => {
    mockFacilitator(TESTNET_KINDS);
    await expect(supportedNetworks("https://f.example")).resolves.toEqual([
      "eip155:80002",
      "hedera:testnet",
    ]);
  });

  it("tolerates a trailing slash rather than requesting a double-slashed path", async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => TESTNET_KINDS }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    await supportedNetworks("https://f.example/");
    expect(fetchMock).toHaveBeenCalledWith("https://f.example/supported");
  });

  it("throws rather than reporting an empty list when the endpoint errors", async () => {
    mockFacilitator({}, false, 502);
    await expect(supportedNetworks("https://f.example")).rejects.toThrow(/502/);
  });

  it("treats a response with no kinds as advertising nothing", async () => {
    mockFacilitator({});
    await expect(supportedNetworks("https://f.example")).resolves.toEqual([]);
  });
});

describe("assertFacilitatorMatchesNetwork", () => {
  it("passes when the facilitator settles on the configured network", async () => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    vi.stubEnv("FACILITATOR_URL", "https://f.example");
    mockFacilitator(TESTNET_KINDS);
    await expect(assertFacilitatorMatchesNetwork()).resolves.toBeUndefined();
  });

  it("passes on mainnet against a mainnet facilitator", async () => {
    vi.stubEnv("HEDERA_NETWORK", "mainnet");
    vi.stubEnv("FACILITATOR_URL", "https://f.example");
    mockFacilitator(MAINNET_KINDS);
    await expect(assertFacilitatorMatchesNetwork()).resolves.toBeUndefined();
  });

  // The exact trap this exists for: HEDERA_NETWORK is flipped to mainnet but a
  // testnet FACILITATOR_URL is still sitting in .env from the previous run.
  it("refuses a testnet facilitator while pointed at mainnet", async () => {
    vi.stubEnv("HEDERA_NETWORK", "mainnet");
    vi.stubEnv("FACILITATOR_URL", "https://f.example");
    mockFacilitator(TESTNET_KINDS);
    await expect(assertFacilitatorMatchesNetwork()).rejects.toThrow(/hedera:mainnet/);
  });

  it("refuses a mainnet facilitator while pointed at testnet", async () => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    vi.stubEnv("FACILITATOR_URL", "https://f.example");
    mockFacilitator(MAINNET_KINDS);
    await expect(assertFacilitatorMatchesNetwork()).rejects.toThrow(/hedera:testnet/);
  });

  it("names both sides so the mismatch is obvious without reading the code", async () => {
    vi.stubEnv("HEDERA_NETWORK", "mainnet");
    vi.stubEnv("FACILITATOR_URL", "https://wrong.example");
    mockFacilitator(TESTNET_KINDS);
    const error = await assertFacilitatorMatchesNetwork().catch((e: Error) => e);
    expect(String(error)).toContain("https://wrong.example");
    expect(String(error)).toContain("hedera:mainnet");
    expect(String(error)).toContain("hedera:testnet");
    expect(String(error)).toMatch(/nothing has been signed/i);
  });

  // Fails closed: an unverifiable fee payer is not something to sign against.
  it("refuses when the facilitator cannot be reached at all", async () => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    vi.stubEnv("FACILITATOR_URL", "https://f.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(assertFacilitatorMatchesNetwork()).rejects.toThrow();
  });

  it("refuses a facilitator that advertises no Hedera network at all", async () => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    vi.stubEnv("FACILITATOR_URL", "https://f.example");
    mockFacilitator({ kinds: [{ network: "solana:mainnet" }] });
    await expect(assertFacilitatorMatchesNetwork()).rejects.toThrow(/solana:mainnet/);
  });
});
