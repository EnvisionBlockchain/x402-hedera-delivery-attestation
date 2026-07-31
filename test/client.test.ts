/**
 * Key parsing. A wrong interpretation here does not fail loudly: it produces a
 * valid-looking key for the wrong curve, and the only symptom is
 * INVALID_SIGNATURE after a transaction has already been submitted.
 */
import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";

import {
  assertSingleSdkInstance,
  deriveKeyCandidates,
  parsePrivateKey,
} from "../src/hedera/client.js";

// Generated per run rather than hardcoded. Never commit key material to a test
// fixture, not even testnet key material: a public repo publishes it, and a
// funded testnet account is still an account someone can drain or spam.
//
// DER self-describes its curve in an algorithm OID, which is the whole point of
// the parsing behaviour under test:
//   Ed25519   302e020100300506032b6570...      OID 2b6570
//   secp256k1 3030020100300706052b8104000a...  OID 2b8104000a
const ED25519_KEY = PrivateKey.generateED25519();
const ED25519_DER = ED25519_KEY.toStringDer();
const ED25519_EXPECTED_PUBKEY = ED25519_KEY.publicKey.toStringRaw();

const ECDSA_KEY = PrivateKey.generateECDSA();
const ECDSA_DER = ECDSA_KEY.toStringDer();
const ECDSA_EXPECTED_PUBKEY = ECDSA_KEY.publicKey.toStringRaw();

describe("test fixtures", () => {
  it("generated the DER encodings the parsing tests assume", () => {
    expect(ED25519_DER).toMatch(/^302e020100300506032b6570/);
    expect(ECDSA_DER).toMatch(/^3030020100300706052b8104000a/);
  });
});

describe("assertSingleSdkInstance", () => {
  it("passes when @x402/hedera and @hiero-ledger/sdk resolve to one install", () => {
    expect(() => assertSingleSdkInstance()).not.toThrow();
  });
});

describe("parsePrivateKey", () => {
  // Regression: fromStringECDSA silently accepts DER-encoded Ed25519 bytes and
  // returns a wrong key. The DER algorithm OID has to win.
  it("respects the Ed25519 OID in a DER key instead of guessing ECDSA", () => {
    expect(parsePrivateKey(ED25519_DER, "test").publicKey.toStringRaw()).toBe(
      ED25519_EXPECTED_PUBKEY,
    );
  });

  it("respects the secp256k1 OID in a DER key", () => {
    expect(parsePrivateKey(ECDSA_DER, "test").publicKey.toStringRaw()).toBe(ECDSA_EXPECTED_PUBKEY);
  });

  it("tolerates a 0x prefix", () => {
    expect(parsePrivateKey(`0x${ECDSA_DER}`, "test").publicKey.toStringRaw()).toBe(
      ECDSA_EXPECTED_PUBKEY,
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(parsePrivateKey(`  ${ECDSA_DER}\n`, "test").publicKey.toStringRaw()).toBe(
      ECDSA_EXPECTED_PUBKEY,
    );
  });

  it("parses raw hex", () => {
    const raw = PrivateKey.generateED25519().toStringRaw();
    expect(() => parsePrivateKey(raw, "test")).not.toThrow();
  });

  it("names the party when it cannot parse at all", () => {
    expect(() => parsePrivateKey("nonsense", "honest seller")).toThrow(/honest seller/);
  });

  it("rejects an empty key", () => {
    expect(() => parsePrivateKey("", "test")).toThrow();
  });
});

describe("deriveKeyCandidates", () => {
  it("returns the DER interpretation first for a DER key", () => {
    const candidates = deriveKeyCandidates(ED25519_DER);
    expect(candidates[0]?.curve).toBe("DER");
    expect(candidates[0]?.publicKey).toBe(ED25519_EXPECTED_PUBKEY);
  });

  it("offers more than one interpretation for ambiguous raw hex", () => {
    // 32 raw bytes are a valid Ed25519 seed and a valid secp256k1 scalar.
    const raw = ED25519_KEY.toStringRaw();
    const candidates = deriveKeyCandidates(raw);
    expect(candidates.length).toBeGreaterThan(1);
    expect(new Set(candidates.map((c) => c.publicKey)).size).toBe(candidates.length);
  });

  it("deduplicates interpretations that agree", () => {
    const candidates = deriveKeyCandidates(ED25519_DER);
    const keys = candidates.map((c) => c.publicKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns an empty list for unparseable input rather than throwing", () => {
    expect(deriveKeyCandidates("nonsense")).toEqual([]);
  });

  it("pairs each candidate's public key with a usable private key", () => {
    for (const candidate of deriveKeyCandidates(ECDSA_DER)) {
      expect(candidate.key.publicKey.toStringRaw()).toBe(candidate.publicKey);
    }
  });
});
