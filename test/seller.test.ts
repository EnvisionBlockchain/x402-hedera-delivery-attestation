/**
 * The dishonest seller must always actually be dishonest.
 *
 * If its fabricated values ever coincide with the real ones, the demo's whole
 * contrast silently collapses: the mock would deliver correctly and the
 * attestation would say so.
 */
import { networkInterfaces } from "node:os";

import { describe, expect, it } from "vitest";

import { toHbar, toTinybars } from "../src/hedera/units.js";
import { fabricateValues } from "../src/seller/dishonest.js";

describe("fabricateValues", () => {
  it("changes the balance", () => {
    const fake = fabricateValues({ balanceHbar: "34033076188.921554", tokenCount: 0 });
    expect(fake.balanceHbar).not.toBe("34033076188.921554");
  });

  it("changes the token count", () => {
    expect(fabricateValues({ balanceHbar: "0.000001", tokenCount: 0 }).tokenCount).not.toBe(0);
    expect(fabricateValues({ balanceHbar: "0.000001", tokenCount: 9 }).tokenCount).not.toBe(9);
  });

  // 141400 is the fixed point of `n * 97 / 100 + 4242`. Without a guard the
  // mock returns the true balance for exactly this input.
  it("never returns the real balance at the formula's fixed point", () => {
    const fake = fabricateValues({ balanceHbar: "0.001414", tokenCount: 0 });
    expect(fake.balanceHbar).not.toBe("0.001414");
  });

  it("never returns the real balance for any value in a wide sweep", () => {
    const collisions: string[] = [];
    for (let n = 0n; n < 300000n; n += 7n) {
      const hbar = toHbar(n);
      if (fabricateValues({ balanceHbar: hbar, tokenCount: 0 }).balanceHbar === hbar) {
        collisions.push(hbar);
      }
    }
    for (let n = 141390n; n <= 141410n; n += 1n) {
      const hbar = toHbar(n);
      if (fabricateValues({ balanceHbar: hbar, tokenCount: 0 }).balanceHbar === hbar) {
        collisions.push(hbar);
      }
    }
    expect(collisions).toEqual([]);
  });

  it("handles a zero balance", () => {
    const fake = fabricateValues({ balanceHbar: "0", tokenCount: 0 });
    expect(fake.balanceHbar).not.toBe("0");
  });

  it("stays plausible rather than absurd for large balances", () => {
    const real = 3403307618892155400n;
    const fake = toTinybars(
      fabricateValues({ balanceHbar: toHbar(real), tokenCount: 0 }).balanceHbar,
    );
    expect(fake).toBeGreaterThan(real / 10n);
    expect(fake).toBeLessThan(real * 10n);
  });

  it("does not lose precision on values beyond Number.MAX_SAFE_INTEGER", () => {
    const real = 9007199254740993000n;
    const fake = toTinybars(
      fabricateValues({ balanceHbar: toHbar(real), tokenCount: 0 }).balanceHbar,
    );
    expect(fake).toBe((real * 97n) / 100n + 4242n);
  });
});

// Regression: the route is registered for GET only, so any other verb missed
// the payment route entirely, x402 reported no-payment-required, and the
// trailing branch served the paid resource for free. Reproduced live with
// `curl -X POST` returning 200 and the full body.
describe("payment gate fails closed", () => {
  // This asserted only that startSeller was a function and the route string was
  // "/snapshot", which is true of the vulnerable version too. The comment above
  // describes a real past bug, so the test has to be able to catch its return.
  const startOnPort = async (port: number) => {
    const { startSeller } = await import("../src/seller/gate.js");
    return startSeller({
      role: "verb test",
      port,
      payTo: "0.0.1234",
      did: "did:hedera:testnet:zdeadbeef_0.0.5678",
      handler: async () => ({ secret: "paid resource" }),
    });
  };

  it("refuses non-GET verbs instead of serving the resource unpaid", async () => {
    const seller = await startOnPort(4101);
    try {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const response = await fetch(`${seller.url}?account=0.0.2`, { method });
        const body = await response.text();
        expect(response.status, `${method} must not be served`).toBe(405);
        // The regression that mattered: the paid body coming back for free.
        expect(body).not.toContain("paid resource");
      }
    } finally {
      await seller.close();
    }
  });

  it("answers unpaid GET with 402 rather than the resource", async () => {
    const seller = await startOnPort(4102);
    try {
      const response = await fetch(`${seller.url}?account=0.0.2`);
      expect(response.status).toBe(402);
      expect(await response.text()).not.toContain("paid resource");
    } finally {
      await seller.close();
    }
  });
});

describe("seller bind address", () => {
  // The gate used to call server.listen(port) with no host, which makes Node
  // listen on every interface. The seller then printed http://127.0.0.1:PORT
  // while actually answering on the machine's LAN address. A demo seller
  // should not be reachable from off-box, and the log line should not be able
  // to disagree with reality.
  const startOn = async (port: number) => {
    const { startSeller } = await import("../src/seller/gate.js");
    return startSeller({
      role: "bind test",
      port,
      payTo: "0.0.1234",
      did: "did:hedera:testnet:zdeadbeef_0.0.5678",
      handler: async () => ({ ok: true }),
    });
  };

  it("binds loopback rather than every interface", async () => {
    const seller = await startOn(4097);
    try {
      expect(seller.url).toContain("127.0.0.1");
      expect(seller.url).not.toContain("0.0.0.0");
      expect(seller.url).not.toContain("::");
    } finally {
      await seller.close();
    }
  });

  it("reports the address it actually bound to, so the two cannot drift", async () => {
    const seller = await startOn(4098);
    try {
      // Reach the seller at exactly the URL it advertised. If the printed
      // host were a constant that had drifted from the real bind, this fails.
      const response = await fetch(seller.url);
      expect(response.status).toBe(402);
    } finally {
      await seller.close();
    }
  });

  // The decisive one. The old code hardcoded 127.0.0.1 into the log line while
  // binding every interface, so asserting on the URL alone would have passed
  // against the bug. This connects to the host's own LAN address, which only
  // succeeds when the bind is wider than loopback.
  it("is not reachable on a non-loopback address", async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!lan) return; // no external interface on this host; nothing to prove

    const seller = await startOn(4100);
    try {
      const reached = await fetch(`http://${lan}:4100/snapshot`, {
        signal: AbortSignal.timeout(2500),
      })
        .then(() => true)
        .catch(() => false);
      expect(reached).toBe(false);
    } finally {
      await seller.close();
    }
  });

  it("still runs the paid route over loopback", async () => {
    const seller = await startOn(4099);
    try {
      const response = await fetch(`${seller.url}?account=0.0.2`);
      // 402 is the gate engaging: unpaid requests are refused, not served.
      expect(response.status).toBe(402);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toBeTruthy();
    } finally {
      await seller.close();
    }
  });
});
