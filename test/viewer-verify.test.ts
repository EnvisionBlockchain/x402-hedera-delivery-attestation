/**
 * The viewer's attestation verification.
 *
 * This is the security control for the page that says "Verify it without
 * trusting us". Two topics are involved and neither carries a submit key:
 * anyone may append to the attestation topic forever, and anyone may append to
 * a DID's topic forever. So the page cannot treat presence on either topic as
 * meaning anything, and it cannot trust any field inside a message to vouch
 * for that message.
 *
 * What it can trust is the identifier. A did:hedera identifier *is* the root
 * public key, base58btc-encoded, so the key an attester must have signed with
 * is derivable from its DID with no network call at all.
 *
 * The viewer has no build step and is opened from disk, so its logic lives in
 * an inline script rather than an importable module. These tests extract the
 * DOM-free script blocks and evaluate them in a sandbox, which keeps the
 * single-file property without leaving the security logic untested.
 */
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";

import fixtures from "./fixtures/attestations.json" with { type: "json" };
import { createEnvelope, identity } from "./helpers/did.js";

type SignedAttestation = {
  record: Record<string, unknown>;
  signature: string;
  attesterPublicKey: string;
};

type DidEvent = { ok: boolean; publicKey: string | null; detail: string };

/**
 * Evaluates the viewer's DOM-free script blocks.
 *
 * Blocks are identified by marker comments rather than by position, so
 * reordering them does not silently drop one from the test.
 */
function loadViewerCrypto(): {
  canonicalize: (v: unknown) => string;
  verifyAttestation: (signed: SignedAttestation, publishedKey: string | null) => unknown;
  readDidEvent: (text: string, did: string) => DidEvent;
  rootKeyFromDid: (did: string) => string | null;
  multibaseToHex: (multibase: string) => string | null;
  base58Decode: (input: string) => Uint8Array | null;
  tallyReputation: (entries: unknown[]) => Map<string, { paid: number; delivered: number; unverified: number; replayed: number; attesters: Set<string> }>;
} {
  const html = readFileSync(new URL("../viewer/index.html", import.meta.url), "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  const domFree = blocks.filter(
    (b) => b.includes("VENDORED THIRD-PARTY CRYPTOGRAPHY") || b.includes("VERIFICATION CORE"),
  );
  expect(domFree.length, "expected the vendored and verification blocks to be present").toBe(2);

  // Every block, not just the DOM-free ones. The page has no build step and no
  // type checking, so a syntax error in the render block would otherwise ship
  // green under both `npm test` and `npm run typecheck` and only surface as a
  // blank page for a reader.
  blocks.forEach((block, index) => {
    expect(() => new Script(block), `script block ${index} must parse`).not.toThrow();
  });

  const context = createContext({
    TextEncoder,
    TextDecoder,
    console,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
  });
  new Script(
    `${domFree.join("\n")}\nthis.__api = { canonicalize, verifyAttestation, readDidEvent, rootKeyFromDid, multibaseToHex, base58Decode, tallyReputation };`,
  ).runInContext(context);
  return (context as { __api: ReturnType<typeof loadViewerCrypto> }).__api;
}

const attesterDid = fixtures.attesterDid;
/** The trust anchor, derived from the identifier rather than read anywhere. */
const publishedKey = String(fixtures.attestations[0]?.attesterPublicKey ?? "");

const genuine = fixtures.attestations[0] as SignedAttestation;
const alsoGenuine = fixtures.attestations[1] as SignedAttestation;

describe("canonicalize", () => {
  const { canonicalize } = loadViewerCrypto();

  // The signature covers these exact bytes. Any divergence from the Node
  // implementation in src/verifier/attest.ts fails every genuine signature,
  // which the forgery test alone would not catch: it would pass for the
  // wrong reason.
  it("sorts keys regardless of insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested objects too", () => {
    expect(canonicalize({ z: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"z":{"c":2,"d":1}}');
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles null, strings needing escapes, and nested arrays", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize({ s: 'a"b' })).toBe('{"s":"a\\"b"}');
    expect(canonicalize({ a: [{ b: 1, a: 2 }] })).toBe('{"a":[{"a":2,"b":1}]}');
  });
});

describe("rootKeyFromDid", () => {
  const { rootKeyFromDid, multibaseToHex, base58Decode } = loadViewerCrypto();

  // The property that makes the page trustworthy offline: the attester's key
  // comes out of its DID string, so the page never has to be told what it is.
  it("derives the attester's key from the DID alone", () => {
    expect(rootKeyFromDid(attesterDid)).toBe(publishedKey);
  });

  it("agrees with the Node implementation on the multibase form", async () => {
    const node = await import("../src/hedera/did.js");
    const multibase = `z${"6MksvXyDxRzrU1Aec6f9sw2fRkFqoxhf6vCcPMWDRSbwyLh"}`;
    expect(multibaseToHex(multibase)).toBe(node.multibaseToHex(multibase));
    expect(rootKeyFromDid(attesterDid)).toBe(node.rootKeyFromDid(attesterDid));
    expect(Array.from(base58Decode("1112") as Uint8Array)).toEqual(
      Array.from(node.base58Decode("1112") as Uint8Array),
    );
  });

  it("returns null rather than throwing on anything malformed", () => {
    for (const bad of ["", "hello", "did:key:abc_0.0.1", `${attesterDid}#did-root-key`]) {
      expect(rootKeyFromDid(bad)).toBeNull();
    }
  });
});

describe("readDidEvent", () => {
  const { readDidEvent } = loadViewerCrypto();

  it("accepts the create event this identity actually published to HCS", () => {
    const result = readDidEvent(fixtures.attesterCreateEvent, attesterDid);
    expect(result.ok).toBe(true);
    expect(result.publicKey).toBe(publishedKey);
  });

  // THE REBINDING ATTACK, and the one that inverts every other check.
  //
  // DID topics carry no submit key. An attacker appends their own create event
  // claiming the victim's DID but carrying the attacker's key, correctly signed
  // by that key so it is internally consistent. A resolver that believed the
  // message would hand verifyAttestation the attacker's key as the trust
  // anchor: the attacker's forgeries would render as verified and the genuine
  // holder's attestations as invalid.
  it("refuses a self-consistent event that rebinds the DID to another key", () => {
    const attacker = PrivateKey.generateED25519();
    const forged = createEnvelope({
      signingKey: attacker,
      did: attesterDid,
      publishedMultibase: identity(attacker).multibase,
    });
    const result = readDidEvent(forged, attesterDid);
    expect(result.ok).toBe(false);
    expect(result.publicKey).toBeNull();
    expect(result.detail).toMatch(/commits to/);
  });

  // The other half of the same attack: publish the victim's real key, but with
  // a signature the attacker could not have produced. Nothing then proves the
  // publisher held the private half.
  it("refuses an event whose envelope signature does not verify", () => {
    const tampered = JSON.parse(fixtures.attesterCreateEvent) as {
      message: { timestamp: string };
      signature: string;
    };
    tampered.message.timestamp = "2020-01-01T00:00:00.000Z";
    const result = readDidEvent(JSON.stringify(tampered), attesterDid);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/signature does not verify/);
  });

  it("refuses a create event for a different DID", () => {
    const other = attesterDid.replace(/_0\.0\.\d+$/, "_0.0.999999");
    expect(readDidEvent(fixtures.attesterCreateEvent, other).ok).toBe(false);
  });

  it("never throws on the junk anyone can append to a topic", () => {
    for (const junk of ["", "not json", "{}", '{"message":{}}', '{"message":null}']) {
      expect(() => readDidEvent(junk, attesterDid)).not.toThrow();
      expect(readDidEvent(junk, attesterDid).ok).toBe(false);
    }
  });
});

describe("verifyAttestation", () => {
  const { verifyAttestation } = loadViewerCrypto();

  it("accepts a genuine attestation captured from the live topic", () => {
    const result = verifyAttestation(genuine, publishedKey) as { verified: boolean };
    expect(result.verified).toBe(true);
  });

  it("accepts the second genuine attestation, with the opposite verdict", () => {
    const result = verifyAttestation(alsoGenuine, publishedKey) as { verified: boolean };
    expect(result.verified).toBe(true);
    // The two fixtures carry opposite delivery verdicts. Verification is about
    // authenticity, not about whether the seller delivered.
    expect(genuine.record.delivered).not.toBe(alsoGenuine.record.delivered);
  });

  // THE ATTACK THIS EXISTS TO STOP.
  //
  // Anyone can append to the topic. The forger names the real verifier as
  // attester and copies its real key into attesterPublicKey, which is public
  // and sitting in the attester's own DID string. Every check the page performed
  // before this unit passed. Only the signature exposes it.
  it("rejects a forgery that copies the real attester's published key", () => {
    const forged: SignedAttestation = {
      record: { ...genuine.record, delivered: false, reason: "fabricated by an attacker" },
      signature: genuine.signature,
      attesterPublicKey: publishedKey,
    };
    const result = verifyAttestation(forged, publishedKey) as { verified: boolean };
    expect(result.verified).toBe(false);
  });

  it("rejects a forgery with an entirely invented signature", () => {
    const forged: SignedAttestation = { ...genuine, signature: "11".repeat(64) };
    expect((verifyAttestation(forged, publishedKey) as { verified: boolean }).verified).toBe(false);
  });

  it("rejects a record mutated after signing, proving the signature covers all of it", () => {
    for (const field of ["delivered", "sellerDid", "paymentTxId", "responseSha256"]) {
      const forged: SignedAttestation = {
        ...genuine,
        record: { ...genuine.record, [field]: "tampered" },
      };
      const result = verifyAttestation(forged, publishedKey) as { verified: boolean };
      expect(result.verified, `mutating ${field} should invalidate the signature`).toBe(false);
    }
  });

  // attesterPublicKey is attacker-controlled. The DID is the trust anchor, so a
  // disagreement is refused rather than resolved in favour of the message.
  it("refuses when the message's key disagrees with the DID's root key", () => {
    const forged: SignedAttestation = { ...genuine, attesterPublicKey: "ab".repeat(32) };
    const result = verifyAttestation(forged, publishedKey) as {
      verified: boolean;
      state: string;
    };
    expect(result.verified).toBe(false);
    expect(result.state).toBe("key-mismatch");
  });

  it("reports an unresolvable attester as its own state, not as verified or forged", () => {
    const result = verifyAttestation(genuine, null) as { verified: boolean; state: string };
    expect(result.verified).toBe(false);
    expect(result.state).toBe("unresolved");
  });

  it("never throws on malformed input, since anyone can put anything on the topic", () => {
    const junk = [
      { record: {}, signature: "", attesterPublicKey: "" },
      { record: {}, signature: "zzzz", attesterPublicKey: publishedKey },
      { record: { a: 1 }, signature: "aa", attesterPublicKey: publishedKey },
    ] as SignedAttestation[];
    for (const bad of junk) {
      expect(() => verifyAttestation(bad, publishedKey)).not.toThrow();
      expect((verifyAttestation(bad, publishedKey) as { verified: boolean }).verified).toBe(false);
    }
  });
});

describe("tallyReputation", () => {
  const { tallyReputation } = loadViewerCrypto();
  const VERIFIER = "did:hedera:testnet:VVV_0.0.1";
  const SELLER = "did:hedera:testnet:SSS_0.0.2";

  const entry = (over: Record<string, unknown> = {}, verified = true) => ({
    record: {
      sellerDid: SELLER,
      attesterDid: VERIFIER,
      paymentTxId: "0.0.1@1.1",
      delivered: true,
      ...over,
    },
    check: { verified },
  });

  it("counts one verdict per payment", () => {
    const row = tallyReputation([entry(), entry()]).get(SELLER)!;
    expect(row.paid).toBe(1);
    expect(row.delivered).toBe(1);
    expect(row.replayed).toBe(1);
  });

  it("counts distinct payments separately", () => {
    const row = tallyReputation([entry(), entry({ paymentTxId: "0.0.1@2.2" })]).get(SELLER)!;
    expect(row.paid).toBe(2);
    expect(row.replayed).toBe(0);
  });

  // THE ATTACK THE ATTESTER KEY EXISTS TO STOP.
  //
  // Anyone can mint a did:hedera and sign a verdict about somebody else's
  // payment. The topic reads oldest-first, so a self-issued "delivered" lands
  // ahead of the real verifier's "not delivered". Keyed on the payment alone,
  // the genuine verdict is then discarded as a duplicate and the seller's
  // record is laundered without forging a single signature.
  it("does not let one attester suppress another's verdict on the same payment", () => {
    const attacker = "did:hedera:testnet:AAA_0.0.9";
    const rows = tallyReputation([
      entry({ attesterDid: attacker, delivered: true }),
      entry({ attesterDid: VERIFIER, delivered: false }),
    ]).get(SELLER)!;
    expect(rows.paid).toBe(2);
    expect(rows.replayed).toBe(0);
    expect(rows.delivered).toBe(1);
  });

  // THE COST OF KEYING PER ATTESTER, made visible rather than argued away.
  //
  // Closing cross-attester suppression opened its mirror image: N minted
  // identities contribute N counted rows about one payment, every signature
  // genuine. Counting alone cannot close both, because "whose word counts" is
  // not answerable from an open topic. So the tally reports how many distinct
  // identities a row is built from, and the table shows it.
  it("reports how many distinct attesters a row is built from", () => {
    const one = tallyReputation([entry()]).get(SELLER)!;
    expect(one.attesters.size).toBe(1);

    const many = tallyReputation(
      Array.from({ length: 25 }, (_, i) =>
        entry({ attesterDid: `did:hedera:testnet:ATK${i}_0.0.9`, delivered: false }),
      ),
    ).get(SELLER)!;
    // Every one of these counts, and that is the point: the reader is shown that
    // twenty-five separate identities produced them.
    expect(many.paid).toBe(25);
    expect(many.attesters.size).toBe(25);
  });

  it("excludes unverified entries rather than tallying them", () => {
    const row = tallyReputation([entry({}, true), entry({ paymentTxId: "0.0.1@3.3" }, false)]).get(SELLER)!;
    expect(row.paid).toBe(1);
    expect(row.unverified).toBe(1);
  });

  it("never throws on malformed entries", () => {
    expect(() => tallyReputation([{}, { record: null }, { record: {}, check: null }])).not.toThrow();
  });
});
