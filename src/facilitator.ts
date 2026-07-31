/**
 * Facilitator preflight.
 *
 * The facilitator co-signs as fee payer and submits the transfer, so it has to
 * be on the same network as everything else. A testnet facilitator cannot
 * settle a mainnet transfer, and the failure surfaces deep inside the payment
 * flow as a rejected settlement rather than as a configuration error.
 *
 * That mismatch is easy to reach by accident: `FACILITATOR_URL` in a `.env`
 * outlives a change to `HEDERA_NETWORK`, so flipping the network alone leaves
 * the old facilitator pinned. This asks the facilitator what it actually
 * supports and refuses before anything is signed.
 */
import { caip2Network, facilitatorUrl } from "./config.js";

type SupportedKind = { network?: string; scheme?: string };
type SupportedResponse = { kinds?: SupportedKind[] };

/**
 * Networks a facilitator advertises on its `/supported` endpoint.
 *
 * @param url - Facilitator base URL
 * @returns CAIP-2 network identifiers it claims to settle
 */
export async function supportedNetworks(url: string): Promise<string[]> {
  const response = await fetch(`${url.replace(/\/+$/, "")}/supported`);
  if (!response.ok) {
    throw new Error(
      `Facilitator ${url} returned ${response.status} for /supported, so it could not be checked. ` +
        `Confirm FACILITATOR_URL points at a running x402 facilitator.`,
    );
  }
  const body = (await response.json()) as SupportedResponse;
  return (body.kinds ?? []).map((k) => k.network).filter((n): n is string => Boolean(n));
}

/**
 * Refuses to continue when the facilitator cannot settle on our network.
 *
 * Fails closed on an unreachable facilitator too: an unverified fee payer is
 * not something to sign a transfer against.
 *
 * @throws When the facilitator does not advertise the configured network
 */
export async function assertFacilitatorMatchesNetwork(): Promise<void> {
  const url = facilitatorUrl();
  const want = caip2Network();
  const advertised = await supportedNetworks(url);

  if (advertised.includes(want)) return;

  throw new Error(
    `Facilitator mismatch. Nothing has been signed.\n` +
      `  configured network : ${want}\n` +
      `  facilitator        : ${url}\n` +
      `  it settles         : ${advertised.length ? advertised.join(", ") : "(nothing)"}\n\n` +
      `  This facilitator cannot settle on ${want}. The usual cause is a FACILITATOR_URL\n` +
      `  left in .env from a different network. Remove it to get the right default for\n` +
      `  ${want}, or set it to a facilitator that serves ${want}.`,
  );
}
