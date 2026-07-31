/**
 * Reads the delivery attestations back from HCS.
 *
 * Deliberately depends on nothing this repo runs. It talks only to the public
 * mirror node, resolves the attester's DID from a different topic, and checks
 * each signature independently. This is what a stranger would do, and it is the
 * proof that these attestations are readable by anyone.
 */
// PublicKey is not in the curated @x402/hedera re-export list, so it comes
// from the SDK directly. Safe because both resolve to one install, which
// assertSingleSdkInstance verifies.
import { PublicKey } from "@hiero-ledger/sdk";

import { hashscanTopic, hashscanTx, provisioned } from "../src/config.js";
import { resolveDid, rootKeyFromDid } from "../src/hedera/did.js";
import { readTopicMessages, waitForTopicMessages } from "../src/hedera/mirror.js";
import { verifyAttestationSignature, type SignedAttestation } from "../src/verifier/attest.js";

/** `--last N` keeps output legible as the topic accumulates across runs. */
function lastN(): number | null {
  const i = process.argv.indexOf("--last");
  if (i < 0) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function main(): Promise<void> {
  const topicId = provisioned.attestationTopicId();
  console.log(`Delivery attestations on HCS topic ${topicId}`);
  console.log(`  ${hashscanTopic(topicId)}\n`);

  let { messages, truncated } = await readTopicMessages(topicId);
  if (messages.length === 0) {
    // Mirror node ingestion lags consensus by a second or two, so running this
    // immediately after `npm run demo` can legitimately come back empty. The
    // demo script tells you to do exactly that, so wait rather than report
    // nothing.
    console.log("  nothing yet, waiting for mirror node ingestion...\n");
    try {
      messages = await waitForTopicMessages(topicId, 1, 20_000);
    } catch {
      console.log("No attestations on this topic. Run `npm run demo` first.");
      return;
    }
  }

  if (truncated) {
    // Say so rather than present a partial ledger as a complete one.
    console.log(
      `  this topic is longer than this tool reads in one go; showing the oldest ${messages.length} messages\n`,
    );
  }

  const limit = lastN();
  const total = messages.length;
  if (limit && total > limit) {
    messages = messages.slice(-limit);
    console.log(`  showing the last ${limit} of ${total} attestations on this topic\n`);
  }

  // Resolving the attester's DID is what turns "someone said this" into
  // "this named identity said this".
  const attesterKeys = new Map<string, PublicKey | null>();

  /**
   * The key an attester DID commits to, once its publication is confirmed.
   *
   * Two separate things, in this order. The key comes out of the identifier,
   * which needs no network and nobody's word for it. Resolution is then run to
   * confirm the identity really was published, and returns null for a topic
   * carrying a document that does not match the DID. Skipping resolution would
   * still verify signatures correctly, but would report an identity that was
   * never registered as though it had been.
   */
  async function attesterKey(did: string): Promise<PublicKey | null> {
    const cached = attesterKeys.get(did);
    if (cached !== undefined) return cached;
    let key: PublicKey | null = null;
    const hex = rootKeyFromDid(did);
    if (hex && (await resolveDid(did))) {
      try {
        key = PublicKey.fromStringED25519(hex);
      } catch {
        key = null;
      }
    }
    attesterKeys.set(did, key);
    return key;
  }

  let verified = 0;
  let unverified = 0;
  let duplicates = 0;
  let delivered = 0;
  // One verdict per payment, per attester. A genuine attestation copied and
  // appended a second time verifies, because the signature is real, so counting
  // it twice would let anyone move a seller's record without forging anything.
  //
  // The attester belongs in the key. Without it the rule becomes a weapon:
  // anyone can mint a DID, self-issue a verdict about someone else's payment,
  // and because the topic reads oldest-first their entry lands first and
  // relabels the real verifier's verdict a duplicate.
  const countedPayments = new Set<string>();

  for (const message of messages) {
    let signed: SignedAttestation;
    try {
      signed = JSON.parse(message.contents) as SignedAttestation;
    } catch {
      console.log(`  #${message.sequenceNumber}  (unparseable message, skipping)\n`);
      unverified += 1;
      continue;
    }
    const record = signed?.record;
    // This topic has no submit key, so anything at all may appear on it. A
    // message that parses as JSON but is not an attestation is expected
    // traffic, not an error, and must not reach the field accesses below.
    if (!record || record.type !== "x402.delivery-attestation") {
      console.log(`  #${message.sequenceNumber}  (not a delivery attestation, skipping)\n`);
      unverified += 1;
      continue;
    }

    let signatureState = "unverified: the attester's DID could not be resolved";
    const key = record.attesterDid ? await attesterKey(record.attesterDid) : null;
    if (key) {
      const ok = verifyAttestationSignature(signed, key);
      signatureState = ok
        ? "VALID (checked against the attester's DID)"
        : "INVALID: this was not signed by the identity it names";
      if (!ok) {
        unverified += 1;
      } else {
        const payment = `${record.attesterDid}|${record.sellerDid}|${record.paymentTxId}`;
        if (countedPayments.has(payment)) {
          duplicates += 1;
          signatureState += ", but this payment was already attested above";
        } else {
          countedPayments.add(payment);
          verified += 1;
          if (record.delivered) delivered += 1;
        }
      }
    } else {
      unverified += 1;
    }

    console.log(`  #${message.sequenceNumber}  ${record.delivered ? "DELIVERED" : "NOT DELIVERED"}`);
    console.log(`     service    : ${record.service}`);
    console.log(`     seller     : ${record.sellerDid}`);
    console.log(`     buyer      : ${record.buyerDid}`);
    console.log(`     attester   : ${record.attesterDid}`);
    console.log(`     payment    : ${record.paymentTxId}`);
    if (record.paymentTxId) {
      console.log(`                  ${hashscanTx(record.paymentTxId)}`);
    }
    console.log(`     reason     : ${record.reason}`);
    console.log(`     body sha256: ${record.responseSha256}`);
    console.log(`     signature  : ${signatureState}`);
    console.log("");
  }

  // Only verified attestations are counted, one per payment. An entry nobody
  // signed for is not evidence about anything, and tallying either an unsigned
  // entry or a replayed one would let anyone move these numbers by appending to
  // a topic that is open to the whole network.
  console.log(
    `${verified} verified attestation(s): ${delivered} delivered, ${verified - delivered} not delivered.`,
  );
  if (unverified > 0) {
    console.log(
      `${unverified} message(s) on this topic could not be verified and are excluded from the counts.`,
    );
  }
  if (duplicates > 0) {
    console.log(
      `${duplicates} message(s) re-attested a payment already counted above, and were counted once.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error("Failed to read attestations:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
