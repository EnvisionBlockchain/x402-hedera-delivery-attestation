/**
 * Environment configuration.
 *
 * Sections are validated lazily so that a script only needs the variables it
 * actually uses. The smoke test runs with a buyer and a seller account; the
 * full demo needs all four parties plus the values written by `bootstrap`.
 */
import "dotenv/config";

const SETUP_HINT =
  "Copy .env.example to .env and fill it in. " +
  "Testnet account ids and keys come from https://portal.hedera.com/ (free, funded by the faucet).";

function req(name: string, hint = SETUP_HINT): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var ${name}. ${hint}`);
  }
  return value.trim();
}

function opt(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

export type HederaNetwork = "testnet" | "mainnet";

/**
 * Hedera network. Testnet unless explicitly told otherwise.
 *
 * Mainnet is reachable, but only by naming it. Anything that is neither
 * network is refused rather than coerced, because the failure mode of a typo
 * here is spending real HBAR: `HEDERA_NETWORK=Mainet` must not silently fall
 * back to a default in either direction.
 */
export function network(): HederaNetwork {
  const value = opt("HEDERA_NETWORK", "testnet").toLowerCase();
  if (value !== "testnet" && value !== "mainnet") {
    throw new Error(
      `HEDERA_NETWORK is "${value}". Set it to "testnet" or "mainnet". ` +
        `Nothing else is accepted, so that a typo cannot pick a network for you.`,
    );
  }
  return value;
}

/** True when pointed at mainnet, where every transfer costs real money. */
export function isMainnet(): boolean {
  return network() === "mainnet";
}

/** CAIP-2 network identifier used by x402. */
export function caip2Network(): `hedera:${HederaNetwork}` {
  return `hedera:${network()}`;
}

/** Asset id x402 uses for native HBAR. HTS tokens would need association first. */
export const HBAR_ASSET = "0.0.0" as const;

export function mirrorNodeUrl(): string {
  return `https://${network()}.mirrornode.hedera.com`;
}

export function hashscanBase(): string {
  return `https://hashscan.io/${network()}`;
}

export type PartyCredentials = {
  readonly label: string;
  readonly accountId: string;
  readonly privateKey: string;
};

function party(label: string, prefix: string): PartyCredentials {
  return {
    label,
    accountId: req(`${prefix}_ACCOUNT_ID`),
    privateKey: req(`${prefix}_PRIVATE_KEY`),
  };
}

/**
 * The buyer, which doubles as the operator that funds provisioning.
 *
 * Accepts the conventional HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY names used
 * throughout Hedera's own documentation, so the demo can be run by exporting
 * two variables without editing any file. BUYER_* wins when both are set.
 */
function buyerCredentials(): PartyCredentials {
  const accountId = process.env.BUYER_ACCOUNT_ID?.trim() || process.env.HEDERA_ACCOUNT_ID?.trim();
  const privateKey = process.env.BUYER_PRIVATE_KEY?.trim() || process.env.HEDERA_PRIVATE_KEY?.trim();
  if (!accountId || !privateKey) {
    throw new Error(
      "No Hedera credentials found. Set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY, either as\n" +
        "environment variables or in a .env file. One funded testnet account is enough; everything\n" +
        "else is provisioned from it.\n\n" +
        "  HEDERA_ACCOUNT_ID=0.0.xxxxx HEDERA_PRIVATE_KEY=302e... npm start\n\n" +
        "Free testnet accounts, with faucet HBAR, come from https://portal.hedera.com/\n" +
        "Either key type works, and both settle x402 payments. Prefer the ED25519 key: a\n" +
        "did:hedera root key must be Ed25519, so an ED25519 account can carry one key for\n" +
        "both its identity and its payments. An ECDSA account needs a second, identity-only\n" +
        "key, which bootstrap generates and explains.",
    );
  }
  return { label: "buyer", accountId, privateKey };
}

export const credentials = {
  buyer: buyerCredentials,
  seller: () => party("honest seller", "SELLER"),
  mockSeller: () => party("dishonest seller (deliberate mock)", "MOCK_SELLER"),
  verifier: () => party("verifier", "VERIFIER"),
};

/**
 * Account that receives payment.
 *
 * Only the id is needed to be paid; a payee never signs the transfer. Kept
 * separate from `credentials.seller()` so the smoke test can run with a single
 * funded account plus any valid destination.
 */
export function payToAccountId(): string {
  return req("SELLER_ACCOUNT_ID");
}

/**
 * Facilitator that co-signs as fee payer and submits the transfer.
 *
 * The default follows the network, since a testnet facilitator cannot settle a
 * mainnet transfer and would fail deep inside the payment flow rather than at
 * startup. Override only to point at your own.
 */
export function facilitatorUrl(): string {
  return opt(
    "FACILITATOR_URL",
    isMainnet() ? "https://api.blocky402.com" : "https://api.testnet.blocky402.com",
  );
}

/** Price of one call, in HBAR. Converted to tinybars only at the x402 boundary. */
export function priceHbar(): string {
  return opt("PRICE_HBAR", "0.01");
}

/**
 * Ceiling the buyer refuses to exceed.
 *
 * Checked against the requirement the client actually selected, and before
 * anything is transmitted. Not before the payload is built: it has to be built
 * first, because a seller can advertise a cheap unsupported option ahead of the
 * real one and checking the advertisement rather than the selection would cap
 * the wrong number. See the note in src/buyer/pay.ts.
 *
 * A spending agent without a cap is a liability even on testnet. On mainnet
 * the default is an order of magnitude tighter, because the cost of an
 * unnoticed loop there is real. Raise it deliberately, not by inheriting a
 * number someone chose for faucet money.
 */
export function maxSpendHbar(): string {
  return opt("MAX_SPEND_HBAR", isMainnet() ? "0.01" : "0.1");
}

/**
 * The account whose state the seller sells a snapshot of.
 *
 * Deliberately an account this demo never transacts against, so that the
 * verifier's independent re-query returns the same values the seller saw.
 */
export function snapshotAccountId(): string {
  return opt("SNAPSHOT_ACCOUNT_ID", "0.0.2");
}

export const ports = {
  honestSeller: Number(opt("HONEST_SELLER_PORT", "4021")),
  dishonestSeller: Number(opt("DISHONEST_SELLER_PORT", "4022")),
  smoke: Number(opt("SMOKE_PORT", "4020")),
};

/** Values written by `npm run bootstrap`. Absent until it has run. */
export const provisioned = {
  attestationTopicId: () =>
    req(
      "ATTESTATION_TOPIC_ID",
      "Run `npm run bootstrap` first; it provisions the DIDs and the attestation topic and prints what to add to .env.",
    ),
  did: (prefix: "BUYER" | "SELLER" | "MOCK_SELLER" | "VERIFIER") =>
    req(
      `${prefix}_DID`,
      "Run `npm run bootstrap` first; it provisions the DIDs and prints what to add to .env.",
    ),
};

export function hashscanTx(transactionId: string): string {
  return `${hashscanBase()}/transaction/${transactionId}`;
}

export function hashscanTopic(topicId: string): string {
  return `${hashscanBase()}/topic/${topicId}`;
}

export function hashscanAccount(accountId: string): string {
  return `${hashscanBase()}/account/${accountId}`;
}

/**
 * One-line network banner, printed by every entry point before it does
 * anything. On mainnet this is the last chance to notice, so it says so.
 */
export function networkBanner(): string {
  return isMainnet()
    ? "network          : hedera:mainnet  ** REAL FUNDS. Every transfer below costs real HBAR. **"
    : "network          : hedera:testnet  (free faucet HBAR, no real value)";
}
