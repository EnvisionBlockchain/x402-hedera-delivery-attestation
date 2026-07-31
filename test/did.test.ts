/**
 * did:hedera parsing and self-certification.
 *
 * Issuance itself belongs to `@hiero-did-sdk/registrar` and is not re-tested
 * here. What is tested is everything this repository does with the strings the
 * registrar produces, because those strings are published permanently to HCS
 * and misreading one is a security bug rather than a display bug.
 *
 * The fixtures below are not invented. They were captured from a DID this
 * repository created on Hedera testnet with the official SDK, so a change that
 * breaks compatibility with the registered method fails here rather than in
 * front of a stranger's resolver.
 */
import { describe, expect, it } from "vitest";

import {
  base58Decode,
  documentMatchesDid,
  documentRootKeyHex,
  multibaseToHex,
  networkFromDid,
  rootKeyFromDid,
  topicIdFromDid,
  type DidDocument,
} from "../src/hedera/did.js";

/** Captured from a real registrar-issued DID on Hedera testnet. */
const DID = "did:hedera:testnet:EUGvdiBZWvWhY7FxUJyBpLCG2EgrFDfqvNSaP9Ub2kZK_0.0.9857096";
const ROOT_KEY_HEX = "c8249e35e359b5ee213a2859d09c1c971bbadaa3e3d48a3a872c1c9cb332da86";
const MULTIBASE = "z6MksvXyDxRzrU1Aec6f9sw2fRkFqoxhf6vCcPMWDRSbwyLh";

function documentFor(did: string, multibase: string): DidDocument {
  return {
    id: did,
    controller: did,
    verificationMethod: [
      {
        id: `${did}#did-root-key`,
        type: "Ed25519VerificationKey2020",
        controller: did,
        publicKeyMultibase: multibase,
      },
    ],
  };
}

describe("base58Decode", () => {
  it.each([
    ["2NEpo7TZRRrLZSi2U", "Hello World!"],
    [
      "USm3fpXnKG5EUBx2ndxBDMPVciP5hGey2Jh4NDv6gmeo1LkMeiKrLJUUBk6Z",
      "The quick brown fox jumps over the lazy dog.",
    ],
  ])("decodes %s", (encoded, plain) => {
    expect(Buffer.from(base58Decode(encoded) as Uint8Array).toString("utf8")).toBe(plain);
  });

  it("preserves leading zero bytes, which encode as leading ones", () => {
    expect(Array.from(base58Decode("1112") as Uint8Array)).toEqual([0, 0, 0, 1]);
  });

  it("returns null rather than throwing on characters outside the alphabet", () => {
    // 0, O, I and l are excluded from base58 precisely because they are
    // confusable, and anyone can put a lookalike DID on a public topic.
    for (const bad of ["", "0OIl", "abc!", "z6Mk O"]) {
      expect(base58Decode(bad)).toBeNull();
    }
  });
});

describe("rootKeyFromDid", () => {
  // The property the whole design rests on: the key is recoverable from the
  // identifier, so no document, topic, or publisher has to be trusted to learn
  // which key an identity speaks with.
  it("recovers the exact root key the SDK encoded", () => {
    expect(rootKeyFromDid(DID)).toBe(ROOT_KEY_HEX);
  });

  it("agrees with the key the document publishes", () => {
    expect(rootKeyFromDid(DID)).toBe(multibaseToHex(MULTIBASE));
  });

  it("tolerates surrounding whitespace", () => {
    expect(rootKeyFromDid(`  ${DID}  `)).toBe(ROOT_KEY_HEX);
  });

  it.each([
    ["empty", ""],
    ["not a DID", "hello"],
    ["wrong method", "did:key:EUGvdiBZWvWhY7FxUJyBpLCG2EgrFDfqvNSaP9Ub2kZK_0.0.1"],
    ["unknown network", "did:hedera:devnet:EUGvdiBZWvWhY7FxUJyBpLCG2EgrFDfqvNSaP9Ub2kZK_0.0.1"],
    ["no topic", "did:hedera:testnet:EUGvdiBZWvWhY7FxUJyBpLCG2EgrFDfqvNSaP9Ub2kZK"],
    ["malformed topic", "did:hedera:testnet:EUGvdiBZWvWhY7FxUJyBpLCG2EgrFDfqvNSaP9Ub2kZK_0.0"],
    ["fragment appended", `${DID}#did-root-key`],
    ["identifier too short", "did:hedera:testnet:abc_0.0.1"],
    ["identifier not base58", "did:hedera:testnet:0OIl_0.0.1"],
  ])("returns null for %s", (_label, input) => {
    expect(rootKeyFromDid(input)).toBeNull();
  });
});

describe("multibaseToHex", () => {
  it("strips the multibase prefix and the Ed25519 multicodec header", () => {
    expect(multibaseToHex(MULTIBASE)).toBe(ROOT_KEY_HEX);
  });

  it("refuses a key that is not multibase base58btc", () => {
    expect(multibaseToHex(MULTIBASE.slice(1))).toBeNull();
    expect(multibaseToHex(`f${ROOT_KEY_HEX}`)).toBeNull();
  });

  // A secp256k1 multicodec header is 0xe7 0x01. Accepting it would mean
  // reporting a 33-byte key as though it were an Ed25519 one.
  it("refuses a well-formed multibase key that is not Ed25519", () => {
    expect(multibaseToHex("z6DtLDaGnaSemDCFRFqGjSJTLBnRLNfLNL74XeS9Fj8LZnDW")).toBeNull();
  });

  it("returns null rather than throwing on junk", () => {
    for (const bad of ["", "z", "z0OIl", "zzz"]) {
      expect(multibaseToHex(bad)).toBeNull();
    }
  });
});

describe("documentRootKeyHex", () => {
  it("reads Ed25519VerificationKey2020 multibase keys", () => {
    expect(documentRootKeyHex(documentFor(DID, MULTIBASE))).toBe(ROOT_KEY_HEX);
  });

  // The method's older verification method type publishes the raw key in plain
  // base58 with no multicodec header. Both are legal in a did:hedera document.
  it("reads Ed25519VerificationKey2018 base58 keys", () => {
    const document: DidDocument = {
      id: DID,
      controller: DID,
      verificationMethod: [
        {
          id: `${DID}#did-root-key`,
          type: "Ed25519VerificationKey2018",
          controller: DID,
          publicKeyBase58: "EUGvdiBZWvWhY7FxUJyBpLCG2EgrFDfqvNSaP9Ub2kZK",
        },
      ],
    };
    expect(documentRootKeyHex(document)).toBe(ROOT_KEY_HEX);
  });

  it("returns null for a document with no usable verification method", () => {
    expect(documentRootKeyHex(null)).toBeNull();
    expect(documentRootKeyHex({ id: DID, controller: DID, verificationMethod: [] })).toBeNull();
  });
});

describe("documentMatchesDid", () => {
  it("accepts the document the DID commits to", () => {
    expect(documentMatchesDid(DID, documentFor(DID, MULTIBASE))).toBe(true);
  });

  // THE ATTACK THIS EXISTS TO STOP.
  //
  // DID topics carry no submit key, so anyone may append to one forever. An
  // attacker appends a document claiming an established DID but carrying their
  // own key. A resolver that believed `id` would then hand every downstream
  // check the attacker's key as the trust anchor, and the attacker's forgeries
  // would verify while the genuine holder's would not.
  it("rejects a document that rebinds the DID to an attacker's key", () => {
    const attacker = "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
    expect(multibaseToHex(attacker)).not.toBe(ROOT_KEY_HEX);
    expect(documentMatchesDid(DID, documentFor(DID, attacker))).toBe(false);
  });

  it("rejects a document with no key at all", () => {
    expect(documentMatchesDid(DID, { id: DID, controller: DID, verificationMethod: [] })).toBe(
      false,
    );
    expect(documentMatchesDid(DID, null)).toBe(false);
  });

  it("rejects a malformed DID even when the document agrees with itself", () => {
    expect(documentMatchesDid("not-a-did", documentFor("not-a-did", MULTIBASE))).toBe(false);
  });

  // The topic is a locator, not part of what the key certifies. So the same key
  // published under a different topic is a different identity rather than a
  // rejected one, and it cannot impersonate the original: impersonation would
  // require producing the original DID string, whose topic segment differs.
  it("treats the same key under another topic as a different identity", () => {
    const other = DID.replace(/_0\.0\.\d+$/, "_0.0.999999");
    expect(other).not.toBe(DID);
    expect(documentMatchesDid(other, documentFor(other, MULTIBASE))).toBe(true);
    expect(topicIdFromDid(other)).toBe("0.0.999999");
  });
});

describe("topicIdFromDid", () => {
  it("extracts the topic the identity is published on", () => {
    expect(topicIdFromDid(DID)).toBe("0.0.9857096");
  });

  it("tolerates surrounding whitespace", () => {
    expect(topicIdFromDid(`  ${DID}  `)).toBe("0.0.9857096");
  });

  it.each([
    ["empty string", ""],
    ["not a did", "hello"],
    ["missing topic", "did:hedera:testnet:zabc"],
    ["malformed topic", "did:hedera:testnet:zabc_0.0"],
    ["trailing junk", "did:hedera:testnet:zabc_0.0.5#did-root-key"],
  ])("returns null for %s", (_label, input) => {
    expect(topicIdFromDid(input)).toBeNull();
  });
});

describe("networkFromDid", () => {
  it("reads the network segment", () => {
    expect(networkFromDid(DID)).toBe("testnet");
    expect(networkFromDid(DID.replace("testnet", "mainnet"))).toBe("mainnet");
  });

  it("returns null for a non-DID", () => {
    expect(networkFromDid("hello")).toBeNull();
  });
});
