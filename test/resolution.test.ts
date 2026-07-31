/**
 * Ledger-backed resolution: picking the right signing key, and resolving a DID
 * from its topic. Both fail in expensive ways if they are wrong. A mis-picked
 * key costs a submitted transaction and an opaque INVALID_SIGNATURE; a
 * mis-resolved DID silently attributes an attestation to the wrong identity.
 *
 * The DID cases build the exact signed envelope the Hiero registrar publishes
 * to HCS and serve it through a stubbed mirror node, so resolution is exercised
 * end to end against the real resolver rather than against a stand-in.
 */
import { PrivateKey } from "@hiero-ledger/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSigningKey } from "../src/hedera/client.js";
import { resolveDid, rootKeyFromDid } from "../src/hedera/did.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function accountResponse(publicKey: string, type = "ECDSA_SECP256K1") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ account: "0.0.5", key: { _type: type, key: publicKey } }),
    })),
  );
}

describe("resolveSigningKey", () => {
  it("returns the key when it controls the account", async () => {
    const key = PrivateKey.generateECDSA();
    accountResponse(key.publicKey.toStringRaw());
    const resolved = await resolveSigningKey("0.0.5", key.toStringDer(), "buyer");
    expect(resolved.publicKey.toStringRaw()).toBe(key.publicKey.toStringRaw());
  });

  // The disambiguation that makes raw hex safe: the same 32 bytes parse as both
  // curves, and only the ledger says which one the account actually uses.
  it("picks the ED25519 interpretation when the account is ED25519", async () => {
    const raw = PrivateKey.generateED25519().toStringRaw();
    const ed = PrivateKey.fromStringED25519(raw);
    accountResponse(ed.publicKey.toStringRaw(), "ED25519");
    const resolved = await resolveSigningKey("0.0.5", raw, "buyer");
    expect(resolved.publicKey.toStringRaw()).toBe(ed.publicKey.toStringRaw());
  });

  it("picks the ECDSA interpretation when the account is ECDSA", async () => {
    const raw = PrivateKey.generateECDSA().toStringRaw();
    const ecdsa = PrivateKey.fromStringECDSA(raw);
    accountResponse(ecdsa.publicKey.toStringRaw(), "ECDSA_SECP256K1");
    const resolved = await resolveSigningKey("0.0.5", raw, "buyer");
    expect(resolved.publicKey.toStringRaw()).toBe(ecdsa.publicKey.toStringRaw());
  });

  it("refuses before signing when the key controls nothing on this account", async () => {
    accountResponse(PrivateKey.generateECDSA().publicKey.toStringRaw());
    await expect(
      resolveSigningKey("0.0.5", PrivateKey.generateECDSA().toStringDer(), "buyer"),
    ).rejects.toThrow(/does not control account 0\.0\.5/);
  });

  it("names the party and shows every derivation when it refuses", async () => {
    accountResponse(PrivateKey.generateECDSA().publicKey.toStringRaw());
    await expect(
      resolveSigningKey("0.0.5", PrivateKey.generateECDSA().toStringDer(), "honest seller"),
    ).rejects.toThrow(/honest seller[\s\S]*key derives/);
  });

  it("reports a missing account rather than a key mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string) => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    await expect(
      resolveSigningKey("0.0.404", PrivateKey.generateECDSA().toStringDer(), "buyer"),
    ).rejects.toThrow(/not found on Hedera testnet/);
  });

  // Three causes, three different fixes. "Does not control account X" alone
  // sent a real user hunting for a format problem when the key was simply dead.
  it("says the key is stale when it controls nothing anywhere", async () => {
    const key = PrivateKey.generateED25519();
    const other = PrivateKey.generateED25519();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("account.publickey")
          ? { ok: true, status: 200, json: async () => ({ accounts: [] }) }
          : {
              ok: true,
              status: 200,
              json: async () => ({
                account: "0.0.5",
                key: { _type: "ED25519", key: other.publicKey.toStringRaw() },
              }),
            },
      ),
    );
    await expect(resolveSigningKey("0.0.5", key.toStringDer(), "buyer")).rejects.toThrow(
      /right type but a different key[\s\S]*stale/,
    );
  });

  it("names the account the key really controls when two cards are mixed up", async () => {
    const key = PrivateKey.generateED25519();
    const other = PrivateKey.generateED25519();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("account.publickey")
          ? { ok: true, status: 200, json: async () => ({ accounts: [{ account: "0.0.777" }] }) }
          : {
              ok: true,
              status: 200,
              json: async () => ({
                account: "0.0.5",
                key: { _type: "ED25519", key: other.publicKey.toStringRaw() },
              }),
            },
      ),
    );
    await expect(resolveSigningKey("0.0.5", key.toStringDer(), "buyer")).rejects.toThrow(
      /This key controls 0\.0\.777, not 0\.0\.5/,
    );
  });

  // The diagnostic lookup must never turn a clear error into a confusing one.
  it("still reports the mismatch when the diagnostic lookup fails", async () => {
    const key = PrivateKey.generateED25519();
    const other = PrivateKey.generateED25519();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("account.publickey")) throw new Error("mirror node down");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: "0.0.5",
            key: { _type: "ED25519", key: other.publicKey.toStringRaw() },
          }),
        };
      }),
    );
    await expect(resolveSigningKey("0.0.5", key.toStringDer(), "buyer")).rejects.toThrow(
      /does not control account 0\.0\.5/,
    );
  });

  // The case a real user hit: the portal displayed the key the account was
  // created with, long after that key had been rotated on chain. Re-copying
  // from the portal returns the same failing value, so the error has to say
  // that rather than send the reader back to it.
  it("recognises a key that matches the account's alias but not its current key", async () => {
    const original = PrivateKey.generateED25519();
    const current = PrivateKey.generateED25519();
    // Alias = base32 of protobuf Key{ed25519: <32 bytes>}: 0x12, 0x20, key.
    const aliasBytes = Buffer.concat([
      Buffer.from([0x12, 0x20]),
      Buffer.from(original.publicKey.toBytesRaw()),
    ]);
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0, value = 0, alias = "";
    for (const byte of aliasBytes) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        alias += ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) alias += ALPHABET[(value << (5 - bits)) & 31];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("account.publickey")
          ? { ok: true, status: 200, json: async () => ({ accounts: [] }) }
          : {
              ok: true,
              status: 200,
              json: async () => ({
                account: "0.0.9918",
                alias,
                key: { _type: "ED25519", key: current.publicKey.toStringRaw() },
              }),
            },
      ),
    );
    await expect(
      resolveSigningKey("0.0.9918", original.toStringDer(), "buyer"),
    ).rejects.toThrow(/was CREATED with[\s\S]*rotated/);
  });

  it("rejects an unparseable key without a network call", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(resolveSigningKey("0.0.5", "nonsense", "buyer")).rejects.toThrow(/Could not parse/);
    expect(spy).not.toHaveBeenCalled();
  });
});

// --- did:hedera resolution -------------------------------------------------

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encodes base58btc.
 *
 * Written independently of the decoder under test rather than derived from it,
 * so that a shared misunderstanding of the alphabet or of leading-zero handling
 * cannot cancel itself out.
 */
function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += (digits[i] as number) << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) out += BASE58[digits[i] as number];
  return out;
}

const TOPIC = "0.0.5";

/** Everything the registrar would derive for a key, without the network. */
function identity(key: PrivateKey, topicId = TOPIC) {
  const raw = Buffer.from(key.publicKey.toBytesRaw());
  const did = `did:hedera:testnet:${base58Encode(raw)}_${topicId}`;
  const multibase = `z${base58Encode(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`;
  return { did, multibase, raw: raw.toString("hex") };
}

/**
 * Builds the signed envelope the registrar submits to HCS.
 *
 * The SDK signs `JSON.stringify(message)`, so those bytes are reproduced here
 * exactly rather than approximated.
 */
function envelope(args: {
  signingKey: PrivateKey;
  did: string;
  publishedMultibase: string;
  controller?: string;
}): string {
  const event = {
    DIDOwner: {
      id: args.did,
      type: "Ed25519VerificationKey2020",
      controller: args.controller ?? args.did,
      publicKeyMultibase: args.publishedMultibase,
    },
  };
  const message = {
    timestamp: new Date("2026-07-31T12:00:00.000Z").toISOString(),
    operation: "create",
    did: args.did,
    event: Buffer.from(JSON.stringify(event)).toString("base64"),
  };
  const signature = args.signingKey.sign(Buffer.from(JSON.stringify(message), "utf8"));
  return JSON.stringify({
    message,
    signature: Buffer.from(signature).toString("base64"),
  });
}

/** Serves topic messages in the mirror node's REST shape. */
function topicMessages(payloads: string[], links: { next: string | null } = { next: null }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        messages: payloads.map((payload, index) => ({
          sequence_number: index + 1,
          consensus_timestamp: `${1785000000 + index}.000000000`,
          message: Buffer.from(payload, "utf8").toString("base64"),
        })),
        links,
      }),
    })),
  );
}

describe("resolveDid", () => {
  const key = PrivateKey.generateED25519();
  const self = identity(key);

  it("resolves a published identity and returns its root key", async () => {
    topicMessages([
      envelope({ signingKey: key, did: self.did, publishedMultibase: self.multibase }),
    ]);
    const document = await resolveDid(self.did);
    expect(document?.id).toBe(self.did);
    expect(document?.verificationMethod[0]?.publicKeyMultibase).toBe(self.multibase);
  });

  // THE ATTACK. The topic has no submit key, so an attacker can append their
  // own well-formed, correctly self-signed create event claiming the victim's
  // DID. Everything inside that message is internally consistent. Only the
  // identifier, which commits to the victim's key, exposes it.
  it("refuses a self-consistent document that rebinds the DID to another key", async () => {
    const attacker = PrivateKey.generateED25519();
    const forged = identity(attacker);
    expect(forged.multibase).not.toBe(self.multibase);

    topicMessages([
      envelope({ signingKey: attacker, did: self.did, publishedMultibase: forged.multibase }),
    ]);
    expect(await resolveDid(self.did)).toBeNull();
  });

  it("ignores messages on the topic that are not DID events", async () => {
    topicMessages([
      "not json at all",
      JSON.stringify({ hello: "world" }),
      envelope({ signingKey: key, did: self.did, publishedMultibase: self.multibase }),
    ]);
    expect((await resolveDid(self.did))?.id).toBe(self.did);
  });

  it("returns null for an empty topic", async () => {
    topicMessages([]);
    expect(await resolveDid(self.did)).toBeNull();
  });

  it("returns null when the mirror node is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, statusText: "Service Unavailable" })),
    );
    expect(await resolveDid(self.did)).toBeNull();
  });

  it("returns null for a malformed DID without calling the network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await resolveDid("not-a-did")).toBeNull();
    expect(await resolveDid("did:hedera:testnet:0OIl_0.0.5")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("agrees with the key recoverable from the DID string alone", () => {
    expect(rootKeyFromDid(self.did)).toBe(self.raw);
  });
});
