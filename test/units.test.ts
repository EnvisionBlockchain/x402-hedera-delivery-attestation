/**
 * HBAR and tinybar conversion.
 *
 * This has to be exact. Hedera balances run past 2^53, where JavaScript numbers
 * stop representing every integer, so anything that touches a float here silently
 * corrupts the value. Every conversion is integer or string work.
 */
import { describe, expect, it } from "vitest";

import { TINYBARS_PER_HBAR, toHbar, toTinybars } from "../src/hedera/units.js";

describe("toHbar", () => {
  it.each([
    ["100000000", "1"],
    ["1000000", "0.01"],
    ["296864", "0.00296864"],
    ["1", "0.00000001"],
    ["0", "0"],
    ["250000000", "2.5"],
  ])("converts %s tinybars to %s HBAR", (tinybars, hbar) => {
    expect(toHbar(tinybars)).toBe(hbar);
  });

  // The case that motivates the whole module: 19 significant digits, well past
  // the point where a double can hold every integer.
  it("is exact for a balance far beyond 2^53", () => {
    expect(toHbar("3403335418296113178")).toBe("34033354182.96113178");
  });

  it("does not lose the trailing digits a float would round away", () => {
    // 3403335418296113178 / 1e8 in floating point loses the tail entirely.
    expect(toHbar("3403335418296113178")).not.toBe(String(3403335418296113178 / 1e8));
  });

  it("strips trailing zeros but keeps significant ones", () => {
    expect(toHbar("100000010")).toBe("1.0000001");
    expect(toHbar("110000000")).toBe("1.1");
  });

  it("accepts a bigint as well as a string", () => {
    expect(toHbar(1_000_000n)).toBe("0.01");
  });

  it("rejects a negative amount rather than emitting a malformed string", () => {
    expect(() => toHbar("-1")).toThrow();
  });

  it("rejects a non-integer input", () => {
    expect(() => toHbar("1.5")).toThrow();
    expect(() => toHbar("abc")).toThrow();
  });
});

describe("toTinybars", () => {
  it.each([
    ["1", 100_000_000n],
    ["0.01", 1_000_000n],
    ["0.00000001", 1n],
    ["0", 0n],
    ["2.5", 250_000_000n],
    ["34033354182.96113178", 3403335418296113178n],
  ])("converts %s HBAR to tinybars", (hbar, tinybars) => {
    expect(toTinybars(hbar)).toBe(tinybars);
  });

  it("tolerates a leading plus and surrounding whitespace", () => {
    expect(toTinybars("  0.01  ")).toBe(1_000_000n);
  });

  it("pads short fractions rather than misreading their magnitude", () => {
    // "0.1" is a tenth of an HBAR, not 1 tinybar.
    expect(toTinybars("0.1")).toBe(10_000_000n);
  });

  it("rejects more precision than a tinybar can hold", () => {
    expect(() => toTinybars("0.000000001")).toThrow(/precision|tinybar/i);
  });

  it("rejects nonsense instead of silently returning zero", () => {
    for (const bad of ["", "abc", "1.2.3", "-1", "1e8"]) {
      expect(() => toTinybars(bad), `should reject ${JSON.stringify(bad)}`).toThrow();
    }
  });
});

describe("round trip", () => {
  it("survives conversion in both directions without drift", () => {
    for (const t of [
      "0", "1", "999", "1000000", "100000000",
      "3403335418296113178", "9007199254740993", "123456789012345678",
    ]) {
      expect(toTinybars(toHbar(t)).toString()).toBe(t);
    }
  });

  it("agrees with the documented ratio", () => {
    expect(TINYBARS_PER_HBAR).toBe(100_000_000n);
    expect(toHbar(TINYBARS_PER_HBAR)).toBe("1");
  });
});
