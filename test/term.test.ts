/**
 * Terminal styling.
 *
 * The properties that matter are that colour never changes the words, and that
 * alignment maths ignores escape sequences. A table that pads a coloured string
 * with a naive length check is off by however many bytes the escapes took.
 */
import { describe, expect, it } from "vitest";

import { c, fail, field, pad, pass, rule, width } from "../src/term.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("width", () => {
  it("ignores escape sequences", () => {
    expect(width("hello")).toBe(5);
    expect(width("\x1b[38;2;1;2;3mhello\x1b[39m")).toBe(5);
    expect(width(c.ok("hello"))).toBe(5);
  });

  it("is zero for an empty string and for pure escapes", () => {
    expect(width("")).toBe(0);
    expect(width("\x1b[1m\x1b[22m")).toBe(0);
  });
});

describe("pad", () => {
  it("pads to a visible width regardless of colour", () => {
    expect(width(pad("ab", 6))).toBe(6);
    expect(width(pad(c.ok("ab"), 6))).toBe(6);
  });

  it("never truncates when the text is already too wide", () => {
    expect(strip(pad("abcdefgh", 3))).toBe("abcdefgh");
  });

  it("aligns a coloured and an uncoloured column identically", () => {
    expect(width(pad(c.bad("no"), 10))).toBe(width(pad("no", 10)));
  });
});

describe("meaning survives without colour", () => {
  // Colour is reinforcement. Stripped output still has to read correctly, for
  // CI logs, pipes, and screen readers.
  it("keeps the label and detail in a passing check", () => {
    expect(strip(pass("balance_matches", "confirmed independently"))).toContain("balance_matches");
    expect(strip(pass("balance_matches", "confirmed independently"))).toContain(
      "confirmed independently",
    );
  });

  it("distinguishes pass from fail without relying on colour", () => {
    expect(strip(pass("x"))).toContain("✓");
    expect(strip(fail("x"))).toContain("✗");
    expect(strip(pass("x"))).not.toBe(strip(fail("x")));
  });

  it("keeps key and value in a field line", () => {
    const line = strip(field("network", "hedera:testnet"));
    expect(line).toContain("network");
    expect(line).toContain("hedera:testnet");
  });
});

describe("layout", () => {
  it("pads check labels to a common column so details line up", () => {
    const short = width(strip(pass("a", "detail")).split("detail")[0] ?? "");
    const long = width(strip(pass("a_much_longer_label", "detail")).split("detail")[0] ?? "");
    expect(short).toBe(long);
  });

  it("draws a rule of the requested width", () => {
    expect(width(rule("━", 12))).toBe(12);
  });
});

describe("detail wrapping", () => {
  const LONG =
    "did:hedera:testnet:z68362ec541d56a4fb29472ab084517e4_0.0.9832135 resolves and is " +
    "bound to 0.0.9832130, the account that was paid";

  it("wraps long details instead of running off the edge", () => {
    const lines = strip(pass("seller_identity_resolves", LONG)).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(process.stdout.columns ?? 100);
    }
  });

  it("aligns continuation lines under the detail column, not column zero", () => {
    const lines = strip(pass("seller_identity_resolves", LONG)).split("\n");
    const detailStart = lines[0]!.indexOf("did:hedera");
    for (const line of lines.slice(1)) {
      expect(line.slice(0, detailStart)).toBe(" ".repeat(detailStart));
    }
  });

  it("leaves short details on one line", () => {
    expect(strip(pass("body_parses", "response body is valid JSON")).split("\n")).toHaveLength(1);
  });

  it("loses no words to wrapping", () => {
    const out = strip(pass("x", LONG));
    expect(out.replace(/\s+/g, " ")).toContain(LONG.replace(/\s+/g, " ").slice(0, 40));
    for (const word of LONG.split(" ")) expect(out).toContain(word);
  });
});
