/**
 * Attestation signing is security-critical: if canonicalization is not
 * deterministic, or a tampered record still verifies, every attestation this
 * demo publishes is worthless.
 */
import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";

import {
  HCS_SINGLE_MESSAGE_LIMIT,
  MAX_REASON_LENGTH,
  buildAttestation,
  canonicalize,
  sha256Hex,
  signAttestation,
  verifyAttestationSignature,
} from "../src/verifier/attest.js";

// Generated per run. Never commit key material to a test fixture.
const KEY = PrivateKey.generateECDSA();

function attestation(overrides: Partial<Parameters<typeof buildAttestation>[0]> = {}) {
  return buildAttestation({
    service: "http://127.0.0.1:4021/snapshot?account=0.0.2",
    paymentTxId: "0.0.7162784@1785351899.289570410",
    sellerDid: "did:hedera:testnet:zSeller_0.0.5001",
    buyerDid: "did:hedera:testnet:zBuyer_0.0.5002",
    attesterDid: "did:hedera:testnet:zAttester_0.0.5003",
    delivered: true,
    reason: "the resource that was paid for was delivered",
    rawResponseBody: '{"resource":"hedera-account-snapshot"}',
    attestedAt: "2026-07-29T18:00:00.000Z",
    ...overrides,
  });
}

describe("canonicalize", () => {
  it("is independent of key insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("sorts nested object keys too", () => {
    const left = canonicalize({ outer: { z: 1, a: { y: 2, b: 3 } } });
    const right = canonicalize({ outer: { a: { b: 3, y: 2 }, z: 1 } });
    expect(left).toBe(right);
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("distinguishes values that would collide under naive concatenation", () => {
    expect(canonicalize({ a: "1", b: "2" })).not.toBe(canonicalize({ a: "12", b: "" }));
  });

  it("handles null, booleans, and numbers", () => {
    expect(canonicalize({ a: null, b: false, c: 0 })).toBe('{"a":null,"b":false,"c":0}');
  });

  it("escapes keys and values so separators cannot be forged", () => {
    expect(canonicalize({ 'a":1,"b': 2 })).toBe('{"a\\":1,\\"b":2}');
  });
});

describe("sha256Hex", () => {
  it("is stable and 64 hex characters", () => {
    const hash = sha256Hex("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(sha256Hex("hello"));
  });

  it("differs for different input", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("buildAttestation", () => {
  it("hashes exactly the bytes the seller returned", () => {
    const body = '{"anything":"at all"}';
    expect(attestation({ rawResponseBody: body }).responseSha256).toBe(sha256Hex(body));
  });

  it("truncates an overlong reason so the HCS message stays unchunked", () => {
    const record = attestation({ reason: "x".repeat(500) });
    expect(record.reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
    expect(record.reason.endsWith("...")).toBe(true);
  });

  it("leaves a short reason untouched", () => {
    expect(attestation({ reason: "short" }).reason).toBe("short");
  });

  it("carries every field the record is supposed to bind together", () => {
    const record = attestation();
    for (const field of [
      "type",
      "version",
      "service",
      "paymentTxId",
      "sellerDid",
      "buyerDid",
      "attesterDid",
      "delivered",
      "reason",
      "responseSha256",
      "attestedAt",
    ]) {
      expect(record).toHaveProperty(field);
    }
  });

  it("produces a signed payload that fits in a single HCS message", () => {
    // Worst realistic case: a maximum-length reason and long DIDs.
    const signed = signAttestation(
      attestation({
        reason: "x".repeat(500),
        sellerDid: `did:hedera:testnet:z${"a".repeat(32)}_0.0.99999999`,
        buyerDid: `did:hedera:testnet:z${"b".repeat(32)}_0.0.99999999`,
        attesterDid: `did:hedera:testnet:z${"c".repeat(32)}_0.0.99999999`,
      }),
      KEY,
    );
    const bytes = Buffer.byteLength(JSON.stringify(signed), "utf8");
    expect(bytes).toBeLessThanOrEqual(HCS_SINGLE_MESSAGE_LIMIT);
  });
});

describe("signAttestation and verifyAttestationSignature", () => {
  it("verifies a signature it just produced", () => {
    const signed = signAttestation(attestation(), KEY);
    expect(verifyAttestationSignature(signed, KEY.publicKey)).toBe(true);
  });

  it("publishes the public key needed to check it", () => {
    const signed = signAttestation(attestation(), KEY);
    expect(signed.attesterPublicKey).toBe(KEY.publicKey.toStringRaw());
  });

  // If any of these pass verification, the attestation layer is decorative.
  it("rejects a flipped delivered verdict", () => {
    const signed = signAttestation(attestation({ delivered: true }), KEY);
    const tampered = { ...signed, record: { ...signed.record, delivered: false } };
    expect(verifyAttestationSignature(tampered, KEY.publicKey)).toBe(false);
  });

  it("rejects a swapped seller DID", () => {
    const signed = signAttestation(attestation(), KEY);
    const tampered = {
      ...signed,
      record: { ...signed.record, sellerDid: "did:hedera:testnet:zEvil_0.0.9" },
    };
    expect(verifyAttestationSignature(tampered, KEY.publicKey)).toBe(false);
  });

  it("rejects an altered response hash", () => {
    const signed = signAttestation(attestation(), KEY);
    const tampered = { ...signed, record: { ...signed.record, responseSha256: sha256Hex("other") } };
    expect(verifyAttestationSignature(tampered, KEY.publicKey)).toBe(false);
  });

  it("rejects an altered payment transaction id", () => {
    const signed = signAttestation(attestation(), KEY);
    const tampered = { ...signed, record: { ...signed.record, paymentTxId: "0.0.1@1.2" } };
    expect(verifyAttestationSignature(tampered, KEY.publicKey)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const signed = signAttestation(attestation(), KEY);
    const other = PrivateKey.generateECDSA();
    expect(verifyAttestationSignature(signed, other.publicKey)).toBe(false);
  });

  it("rejects a garbage signature without throwing", () => {
    const signed = signAttestation(attestation(), KEY);
    expect(() =>
      verifyAttestationSignature({ ...signed, signature: "not-hex" }, KEY.publicKey),
    ).not.toThrow();
    expect(verifyAttestationSignature({ ...signed, signature: "not-hex" }, KEY.publicKey)).toBe(
      false,
    );
  });

  it("rejects an empty signature", () => {
    const signed = signAttestation(attestation(), KEY);
    expect(verifyAttestationSignature({ ...signed, signature: "" }, KEY.publicKey)).toBe(false);
  });

  it("is insensitive to key order in the transported record", () => {
    // JSON round-tripping can reorder keys; the signature must survive it.
    const signed = signAttestation(attestation(), KEY);
    const reordered = JSON.parse(JSON.stringify(signed)) as typeof signed;
    const shuffled = {
      ...reordered,
      record: Object.fromEntries(
        Object.entries(reordered.record).reverse(),
      ) as typeof reordered.record,
    };
    expect(verifyAttestationSignature(shuffled, KEY.publicKey)).toBe(true);
  });
});
