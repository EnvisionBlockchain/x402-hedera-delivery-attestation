/**
 * Delivery attestations, published to the Hedera Consensus Service.
 *
 * The record binds five things together: what was bought, which payment landed,
 * who sold it, who bought it, and who is willing to put their name on the
 * verdict. All three identities are resolvable DIDs, so a stranger holding only
 * the HCS message can check the whole chain against public infrastructure.
 *
 * This is signed JSON, not a Verifiable Credential. The mapping onto a VC is
 * one field rename plus a proof block, and the README documents that path
 * rather than half-building it.
 */
import { createHash } from "node:crypto";

import { TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { Client, PrivateKey } from "@x402/hedera";

/** HCS chunks above roughly this size; staying under keeps one message readable. */
export const HCS_SINGLE_MESSAGE_LIMIT = 1024;

/** Long verdict reasons are truncated so the message stays unchunked. */
export const MAX_REASON_LENGTH = 160;

export type AttestationRecord = {
  readonly type: "x402.delivery-attestation";
  readonly version: "1";
  readonly service: string;
  readonly paymentTxId: string;
  readonly sellerDid: string;
  readonly buyerDid: string;
  readonly attesterDid: string;
  readonly delivered: boolean;
  readonly reason: string;
  readonly responseSha256: string;
  readonly attestedAt: string;
};

export type SignedAttestation = {
  readonly record: AttestationRecord;
  readonly signature: string;
  readonly attesterPublicKey: string;
};

/**
 * Deterministic JSON with sorted keys.
 *
 * A signature is only checkable if both sides serialize identically.
 *
 * @param value - Value to serialize
 * @returns Canonical JSON string
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Builds an attestation record.
 *
 * @param args - Everything the record binds together
 * @param args.service - Resource URL that was purchased
 * @param args.paymentTxId - Hedera transaction id of the settled payment
 * @param args.sellerDid - Seller's DID
 * @param args.buyerDid - Buyer's DID
 * @param args.attesterDid - Verifier's DID
 * @param args.delivered - Whether the purchased resource actually arrived
 * @param args.reason - Human-readable justification for the verdict
 * @param args.rawResponseBody - Exactly the bytes the seller returned
 * @param args.attestedAt - ISO timestamp
 * @returns The record
 */
export function buildAttestation(args: {
  service: string;
  paymentTxId: string;
  sellerDid: string;
  buyerDid: string;
  attesterDid: string;
  delivered: boolean;
  reason: string;
  rawResponseBody: string;
  attestedAt: string;
}): AttestationRecord {
  return {
    type: "x402.delivery-attestation",
    version: "1",
    service: args.service,
    paymentTxId: args.paymentTxId,
    sellerDid: args.sellerDid,
    buyerDid: args.buyerDid,
    attesterDid: args.attesterDid,
    delivered: args.delivered,
    reason:
      args.reason.length > MAX_REASON_LENGTH
        ? `${args.reason.slice(0, MAX_REASON_LENGTH - 3)}...`
        : args.reason,
    responseSha256: sha256Hex(args.rawResponseBody),
    attestedAt: args.attestedAt,
  };
}

/**
 * Signs an attestation with the verifier's key.
 *
 * @param record - Record to sign
 * @param key - Verifier's private key
 * @returns The record plus signature and the public key needed to check it
 */
export function signAttestation(record: AttestationRecord, key: PrivateKey): SignedAttestation {
  const bytes = Buffer.from(canonicalize(record), "utf8");
  return {
    record,
    signature: Buffer.from(key.sign(bytes)).toString("hex"),
    attesterPublicKey: key.publicKey.toStringRaw(),
  };
}

/**
 * Checks an attestation's signature against a public key.
 *
 * Resolve the attester's DID to obtain that key and this becomes a full
 * independent verification, with no trust in whoever handed you the message.
 *
 * @param signed - Signed attestation
 * @param publicKey - Attester's public key, from their resolved DID Document
 * @returns True when the signature is valid
 */
export function verifyAttestationSignature(
  signed: SignedAttestation,
  publicKey: { verify(message: Uint8Array, signature: Uint8Array): boolean },
): boolean {
  try {
    const bytes = Buffer.from(canonicalize(signed.record), "utf8");
    return publicKey.verify(bytes, Buffer.from(signed.signature, "hex"));
  } catch {
    return false;
  }
}

/**
 * Publishes a signed attestation to the shared HCS topic.
 *
 * @param client - Hedera client, operated by the verifier
 * @param topicId - Shared attestation topic
 * @param signed - Signed attestation
 * @returns Sequence number and payload size
 */
export async function publishAttestation(
  client: Client,
  topicId: string,
  signed: SignedAttestation,
): Promise<{ sequenceNumber: string; bytes: number; chunked: boolean }> {
  const payload = JSON.stringify(signed);
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > HCS_SINGLE_MESSAGE_LIMIT) {
    console.warn(
      `[verifier] attestation is ${bytes} bytes and will be chunked across HCS messages.`,
    );
  }

  const receipt = await (
    await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(payload)
      .execute(client)
  ).getReceipt(client);

  return {
    sequenceNumber: receipt.topicSequenceNumber?.toString() ?? "?",
    bytes,
    chunked: bytes > HCS_SINGLE_MESSAGE_LIMIT,
  };
}
