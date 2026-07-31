/**
 * Fixtures for did:hedera identities.
 *
 * The registrar publishes a signed envelope to HCS, and the resolver reads it
 * back through the mirror node's REST API. Tests that stub the mirror node
 * therefore have to produce that exact envelope, or they test a shape the real
 * resolver would reject.
 *
 * base58 is encoded here rather than imported from the source under test, so a
 * shared misunderstanding of the alphabet cannot cancel itself out.
 */
import type { PrivateKey } from "@hiero-ledger/sdk";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
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

export type Identity = {
  /** did:hedera:<network>:<base58 root key>_<topic> */
  readonly did: string;
  /** publicKeyMultibase, as the document publishes it. */
  readonly multibase: string;
  /** Raw 32-byte root public key, hex, as the mirror node reports account keys. */
  readonly raw: string;
  readonly topicId: string;
};

/** Everything the registrar derives for a key, without touching the network. */
export function identity(key: PrivateKey, topicId = "0.0.5001", network = "testnet"): Identity {
  const raw = Buffer.from(key.publicKey.toBytesRaw());
  return {
    did: `did:hedera:${network}:${base58Encode(raw)}_${topicId}`,
    multibase: `z${base58Encode(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`,
    raw: raw.toString("hex"),
    topicId,
  };
}

/**
 * The signed envelope the registrar submits for a DID create event.
 *
 * The SDK signs `JSON.stringify(message)`, so those bytes are reproduced here
 * exactly rather than approximated.
 */
export function createEnvelope(args: {
  signingKey: PrivateKey;
  did: string;
  publishedMultibase: string;
  controller?: string;
  timestamp?: string;
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
    timestamp: args.timestamp ?? "2026-07-31T12:00:00.000Z",
    operation: "create",
    did: args.did,
    event: Buffer.from(JSON.stringify(event)).toString("base64"),
  };
  const signature = args.signingKey.sign(Buffer.from(JSON.stringify(message), "utf8"));
  return JSON.stringify({ message, signature: Buffer.from(signature).toString("base64") });
}

/** A mirror node topic-messages response body carrying the given payloads. */
export function topicMessagesBody(payloads: string[]): unknown {
  return {
    messages: payloads.map((payload, index) => ({
      sequence_number: index + 1,
      consensus_timestamp: `${1785000000 + index}.000000000`,
      message: Buffer.from(payload, "utf8").toString("base64"),
    })),
    links: { next: null },
  };
}
