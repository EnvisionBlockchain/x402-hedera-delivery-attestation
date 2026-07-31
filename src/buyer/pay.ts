/**
 * The buyer's side of an x402 call on Hedera.
 *
 * Deliberately exposed as small steps rather than one opaque function, because
 * the skill in skills/x402-hedera-buyer documents these as the flow an agent
 * follows, and the demo output narrates them one at a time.
 */
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { createClientHederaSigner, inspectHederaTransaction } from "@x402/hedera";
import { ExactHederaScheme as ExactHederaClient } from "@x402/hedera/exact/client";
import type { PrivateKey } from "@x402/hedera";

import { HBAR_ASSET, caip2Network, maxSpendHbar } from "../config.js";
import { formatHbar, toHbar, toTinybars } from "../hedera/units.js";

export type PaidCall = {
  /** Exactly the bytes the seller returned. */
  readonly rawBody: string;
  /** Hedera transaction id of the settled payment. */
  readonly transactionId: string;
  /** DID the seller advertised in its 402, before any money moved. */
  readonly advertisedSellerDid: string;
  /** Account that actually received the payment. */
  readonly payTo: string;
  /** Amount paid, in HBAR. */
  readonly amountHbar: string;
  /**
   * Transaction id decoded from the transaction the buyer itself signed.
   *
   * The seller relays a transaction id in PAYMENT-RESPONSE, and until now that
   * was the only source. Recording what the buyer signed lets the verifier check
   * the two agree rather than taking the seller's word for what it settled.
   */
  readonly signedTransactionId: string;
  /** False when the relayed transaction id disagrees with the signed one. */
  readonly transactionIdMatches: boolean;
  readonly httpStatus: number;
};

/**
 * Pulls the advertised DID out of a 402's resource description.
 *
 * The marker must sit at the start of the description or after a separator, so
 * a key that merely ends in `servedBy` (`notservedBy=...`) does not match.
 *
 * @param description - Resource description from the 402
 * @returns The advertised DID, or empty string when none is present
 */
export function parseAdvertisedDid(description: string | undefined): string {
  const match = /(?:^|[\s|])servedBy=(\S+)/.exec(description ?? "");
  return match?.[1] ?? "";
}

/**
 * Builds an x402 client that can pay on Hedera with a raw key.
 *
 * @param accountId - Buyer's Hedera account id
 * @param key - Key controlling that account
 * @returns Configured HTTP client
 */
export function createBuyer(accountId: string, key: PrivateKey): x402HTTPClient {
  const signer = createClientHederaSigner(accountId, key, { network: caip2Network() });
  return new x402HTTPClient(new x402Client().register("hedera:*", new ExactHederaClient(signer)));
}

/**
 * Requests a resource, pays for it, and returns what came back.
 *
 * Makes no judgement about whether the response is the purchased resource.
 * That is the verifier's job, and keeping the two apart is the point.
 *
 * @param client - Buyer client
 * @param url - Resource URL, including any query parameters
 * @param onStep - Optional progress callback for narrated output
 * @returns The paid call's result
 */
export async function payAndFetch(
  client: x402HTTPClient,
  url: string,
  onStep?: (message: string) => void,
): Promise<PaidCall> {
  const step = onStep ?? (() => {});

  const unpaid = await fetch(url);
  if (unpaid.status !== 402) {
    throw new Error(`Expected 402 from ${url}, got ${unpaid.status}.`);
  }
  const paymentRequired = client.getPaymentRequiredResponse(
    (name) => unpaid.headers.get(name),
    await unpaid.clone().json(),
  );

  const advertised = paymentRequired.accepts?.[0];
  if (!advertised) throw new Error("The 402 advertised no payment options.");

  const advertisedSellerDid = parseAdvertisedDid(paymentRequired.resource?.description);
  step(`seller claims identity ${advertisedSellerDid || "(none advertised)"}`);

  // Hooks get first refusal (a paywall or an approval prompt could short circuit
  // here by supplying headers). Null is the ordinary path.
  let headers = await client.handlePaymentRequired(paymentRequired);

  // Default to the advertised option only for the hook path, where no payload
  // exists to inspect. No hooks are registered in this demo.
  let paidAmount = toHbar(String(advertised.amount ?? "0"));
  let paidTo = String(advertised.payTo ?? "");
  let signedTransactionId = "";

  if (!headers) {
    // Build the payload before checking the cap, so the cap applies to the
    // requirement the client actually SELECTED. Core filters advertised options
    // to the supported scheme and network and then selects independently, so
    // accepts[0] is not necessarily what would be paid: a seller listing a cheap
    // unsupported decoy first could otherwise get an uncapped amount signed.
    // Nothing is sent until the header is attached below, so refusing here costs
    // nothing.
    const payload = await client.createPaymentPayload(paymentRequired);
    const accepted = payload.accepted;
    paidAmount = toHbar(String(accepted?.amount ?? "0"));
    paidTo = String(accepted?.payTo ?? "");

    // The cap counts tinybars. An HTS requirement would be denominated in that
    // token's atomic units, and comparing those against a tinybar ceiling
    // compares two different things: 1000000 units of an 18-decimal token is
    // not 0.01 HBAR. The README calls this cap the only limit on what an
    // arbitrary endpoint can charge, so anything it cannot actually bound is
    // refused rather than waved through.
    const asset = String(accepted?.asset ?? "");
    if (asset !== HBAR_ASSET) {
      throw new Error(
        `Refusing to pay in asset ${asset || "(unspecified)"}: this buyer prices and caps in HBAR only.\n` +
          `  MAX_SPEND_HBAR counts tinybars and cannot bound a token amount, so the cap would not apply.`,
      );
    }

    const cap = maxSpendHbar();
    if (toTinybars(paidAmount) > toTinybars(cap)) {
      throw new Error(
        `Refusing to pay ${formatHbar(paidAmount)} HBAR: above the configured cap of ` +
          `${formatHbar(cap)} HBAR. Raise MAX_SPEND_HBAR only if you meant to.`,
      );
    }

    // Decode the transaction the buyer is about to hand over, so its id is known
    // independently of whatever the seller later claims settled.
    const encoded = (payload.payload as { transaction?: unknown } | undefined)?.transaction;
    if (typeof encoded === "string" && encoded !== "") {
      try {
        signedTransactionId = inspectHederaTransaction(encoded).transactionId;
      } catch {
        // Leave empty; the verifier reports an unknown signed id rather than a match.
      }
    }

    step(`402 received: ${formatHbar(paidAmount)} HBAR to ${paidTo}`);
    headers = client.encodePaymentSignatureHeader(payload);
  }
  step("payment signed, retrying with proof of payment");

  const paid = await fetch(url, { headers });
  const rawBody = await paid.text();
  const settle = client.getPaymentSettleResponse((name) => paid.headers.get(name));

  if (!paid.ok) {
    throw new Error(
      `Paid request failed with ${paid.status}. Settlement said: ${
        settle.errorMessage ?? "(nothing)"
      }`,
    );
  }

  const relayedTransactionId = String(settle.transaction ?? "");
  // A mismatch is evidence for the verifier, not a reason to abort: the payment
  // has already settled by this point, so the run should continue and the
  // discrepancy should end up in the attestation.
  const transactionIdMatches =
    signedTransactionId !== "" && relayedTransactionId === signedTransactionId;
  if (signedTransactionId !== "" && !transactionIdMatches) {
    step(
      `WARNING: seller relayed ${relayedTransactionId} but the buyer signed ${signedTransactionId}`,
    );
  }

  return {
    rawBody,
    transactionId: relayedTransactionId,
    advertisedSellerDid,
    payTo: paidTo,
    amountHbar: paidAmount,
    signedTransactionId,
    transactionIdMatches,
    httpStatus: paid.status,
  };
}
