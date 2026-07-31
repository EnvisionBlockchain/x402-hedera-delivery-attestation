/**
 * Hedera client construction and SDK-instance safety.
 *
 * Import discipline matters here. `@x402/hedera` re-exports a curated subset of
 * `@hiero-ledger/sdk` so a consuming app resolves a single SDK instance; if two
 * physical copies end up on disk, the SDK's internal brand checks fail at
 * runtime with the deeply unhelpful `t.startsWith is not a function`.
 *
 * The re-export list does not include the HCS topic classes this demo needs for
 * DIDs and attestations, so those come from `@hiero-ledger/sdk` directly. That
 * is safe only while both resolve to the same install, which
 * `assertSingleSdkInstance` verifies loudly at startup.
 */
import { Client, PrivateKey } from "@x402/hedera";
import * as hiero from "@hiero-ledger/sdk";

import type { PartyCredentials } from "../config.js";
import { mirrorNodeUrl, network } from "../config.js";

let checked = false;

/**
 * Fails fast if `@x402/hedera` and `@hiero-ledger/sdk` resolved to different
 * installs, converting a baffling runtime error into an actionable one.
 */
export function assertSingleSdkInstance(): void {
  if (checked) return;
  if ((PrivateKey as unknown) !== (hiero.PrivateKey as unknown)) {
    throw new Error(
      "Two different @hiero-ledger/sdk installs are present: the class re-exported by @x402/hedera " +
        "is not the same object as the one from @hiero-ledger/sdk. Hedera's internal brand checks " +
        "will fail at runtime. Fix by pinning @hiero-ledger/sdk to the exact version @x402/hedera " +
        "depends on, then deleting node_modules and package-lock.json and reinstalling.",
    );
  }
  checked = true;
}

/**
 * Parses a Hedera private key, tolerating the formats the portal hands out.
 *
 * The portal issues both ECDSA and ED25519 keys and the key type must match
 * what is on chain for the account. Guessing wrong produces an opaque
 * INVALID_SIGNATURE at submit time, so try each explicitly.
 *
 * @param raw - Private key string, hex or DER, with or without 0x
 * @param label - Party name used in the error message
 * @returns Parsed private key
 */
export function parsePrivateKey(raw: string, label: string): PrivateKey {
  const value = raw.trim().replace(/^0x/i, "");

  // A DER-encoded key names its own algorithm in an OID, so it is authoritative.
  // This must be tried first: fromStringECDSA will happily accept DER-encoded
  // ED25519 bytes and return a silently wrong key, which surfaces later as an
  // opaque INVALID_SIGNATURE rather than a parse error.
  if (/^30[0-9a-f]{2}0201/i.test(value)) {
    try {
      return PrivateKey.fromStringDer(value);
    } catch {
      // fall through to the raw-hex interpretations
    }
  }

  // Raw hex carries no type information. ED25519 is Hedera's historical default,
  // so prefer it, then fall back to ECDSA.
  const attempts: Array<() => PrivateKey> = [
    () => PrivateKey.fromStringED25519(value),
    () => PrivateKey.fromStringECDSA(value),
    () => PrivateKey.fromString(value),
  ];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // try the next encoding
    }
  }
  throw new Error(
    `Could not parse the private key for the ${label}. Expected an ECDSA or ED25519 key ` +
      "as issued by https://portal.hedera.com/ (DER or raw hex, with or without a 0x prefix).",
  );
}

export type KeyCandidate = { curve: string; key: PrivateKey; publicKey: string };

/**
 * Derives every plausible interpretation of a private key string.
 *
 * Raw hex carries no curve information: the same 32 bytes are a valid Ed25519
 * seed and a valid secp256k1 scalar. Rather than guess, enumerate and let the
 * caller disambiguate against the account's on-chain key.
 *
 * @param raw - Private key string, DER or raw hex, with or without 0x
 * @returns Distinct candidate interpretations, labelled by curve
 */
export function deriveKeyCandidates(raw: string): KeyCandidate[] {
  const value = raw.trim().replace(/^0x/i, "");
  const candidates: KeyCandidate[] = [];
  const tryOne = (curve: string, fn: () => PrivateKey): void => {
    try {
      const key = fn();
      candidates.push({ curve, key, publicKey: key.publicKey.toStringRaw() });
    } catch {
      // not this curve
    }
  };
  // DER names its own algorithm, so it is authoritative when present.
  if (/^30[0-9a-f]{2}0201/i.test(value)) {
    tryOne("DER", () => PrivateKey.fromStringDer(value));
  }
  tryOne("ED25519", () => PrivateKey.fromStringED25519(value));
  tryOne("ECDSA", () => PrivateKey.fromStringECDSA(value));

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.publicKey)) return false;
    seen.add(candidate.publicKey);
    return true;
  });
}

/** @deprecated Use deriveKeyCandidates. Retained for the credential preflight. */
export function derivePublicKeyCandidates(raw: string): Array<{ curve: string; publicKey: string }> {
  return deriveKeyCandidates(raw).map(({ curve, publicKey }) => ({ curve, publicKey }));
}

/**
 * Picks the private key interpretation that actually controls an account.
 *
 * Resolves curve ambiguity against the ledger rather than trusting a label, so
 * a correct key in either encoding works and an incorrect one fails here with
 * a clear message instead of as INVALID_SIGNATURE at settlement time.
 *
 * @param accountId - Hedera account the key is claimed to control
 * @param raw - Private key string in any supported encoding
 * @param label - Party name used in error messages
 * @returns The private key interpretation matching the account's on-chain key
 */
export async function resolveSigningKey(
  accountId: string,
  raw: string,
  label: string,
): Promise<PrivateKey> {
  assertSingleSdkInstance();
  const candidates = deriveKeyCandidates(raw);
  if (candidates.length === 0) {
    throw new Error(
      `Could not parse the private key for the ${label}. Expected DER or raw hex from https://portal.hedera.com/`,
    );
  }

  const response = await fetch(
    `${mirrorNodeUrl()}/api/v1/accounts/${accountId}?limit=1`,
  );
  if (!response.ok) {
    throw new Error(
      `Account ${accountId} (${label}) was not found on Hedera ${network()} (mirror node returned ${response.status}).`,
    );
  }
  const info = (await response.json()) as {
    key?: { key?: string; _type?: string };
    alias?: string | null;
  };
  const onchain = (info.key?.key ?? "").toLowerCase();

  const match = candidates.find((candidate) => candidate.publicKey.toLowerCase() === onchain);
  if (match) return match.key;

  // Say *why* it does not match, because the three causes need three different
  // fixes and "does not control account X" sends people to check the wrong one.
  // Asking the mirror node what this key does control separates a stale key
  // from two cards mixed up, and costs a request only on the failure path.
  const elsewhere = await accountsControlledBy(candidates.map((c) => c.publicKey));
  const sameCurve = candidates.some(
    (c) => c.publicKey.length === onchain.length && onchain !== "",
  );
  // An account's alias is the key it was created with and can never change, so
  // a key matching the alias but not the current key is proof the key was
  // rotated. Worth detecting precisely: the Hedera portal has been observed
  // still displaying the original key for such an account, which sends the
  // reader to re-copy the very value that is already failing.
  const aliasKey = aliasPublicKey(info.alias ?? null);
  const matchesAlias =
    aliasKey !== null && candidates.some((c) => c.publicKey.toLowerCase() === aliasKey);

  let diagnosis: string;
  if (matchesAlias) {
    diagnosis =
      `  This key is the one ${accountId} was CREATED with, but its key has since been rotated.\n` +
      `  The account's alias still records your key; the ledger no longer accepts it.\n` +
      `  Re-copying from the portal may not help: it has been seen showing the original\n` +
      `  key for a rotated account. Reset the key on that account, or use a different one.`;
  } else if (elsewhere.length > 0) {
    diagnosis =
      `  This key controls ${elsewhere.join(", ")}, not ${accountId}.\n` +
      `  Two cards have been mixed up. Use that account id, or fetch ${accountId}'s own key.`;
  } else if (sameCurve) {
    diagnosis =
      `  This key is the right type but a different key, and it controls no account on Hedera ${network()}.\n` +
      `  That usually means it is stale: the account was reissued, or the key predates a testnet reset.\n` +
      `  Open ${accountId} on https://portal.hedera.com/ and copy its current private key.`;
  } else {
    diagnosis =
      `  This key controls no account on Hedera ${network()}.\n` +
      `  Copy the account id and its private key from the same card on https://portal.hedera.com/`;
  }

  throw new Error(
    `The configured key for the ${label} does not control account ${accountId}.\n` +
      `  account's on-chain key : ${info.key?._type ?? "unknown"} ${onchain || "(none)"}\n` +
      candidates.map((c) => `  key derives (${c.curve.padEnd(7)}): ${c.publicKey}`).join("\n") +
      `\n${diagnosis}`,
  );
}

/**
 * Which accounts, if any, a set of public keys controls.
 *
 * Diagnostic only, and best effort: a mirror node that is down or slow must not
 * turn a clear "wrong key" error into a confusing one, so every failure here
 * degrades to "found nothing" rather than throwing.
 *
 * @param publicKeys - Candidate public keys, raw hex
 * @returns Account ids found, deduplicated
 */
function aliasPublicKey(alias: string | null): string | null {
  if (!alias) return null;
  try {
    // Base32, no padding, of a protobuf Key. ED25519 is field 2: 0x12, len 0x20.
    const bytes = decodeBase32(alias);
    if (!bytes || bytes.length < 34) return null;
    if (bytes[0] !== 0x12 || bytes[1] !== 0x20) return null;
    return Buffer.from(bytes.subarray(2, 34)).toString("hex").toLowerCase();
  } catch {
    return null;
  }
}

/** RFC 4648 base32, which is how the mirror node encodes an account alias. */
function decodeBase32(input: string): Uint8Array | null {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function accountsControlledBy(publicKeys: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const publicKey of publicKeys) {
    try {
      const response = await fetch(
        `${mirrorNodeUrl()}/api/v1/accounts?account.publickey=${encodeURIComponent(publicKey)}&limit=5`,
      );
      if (!response.ok) continue;
      const body = (await response.json()) as { accounts?: Array<{ account?: string }> };
      for (const account of body.accounts ?? []) {
        if (account.account) found.add(account.account);
      }
    } catch {
      // Diagnostics are not worth failing over.
    }
  }
  return [...found];
}

/**
 * Builds a Hedera client for a party, on the configured network.
 *
 * @param credentials - Account id and private key for the party
 * @returns Configured client with the party set as operator
 */
export function hederaClient(credentials: PartyCredentials): Client {
  const key = parsePrivateKey(credentials.privateKey, credentials.label);
  return hederaClientWithKey(credentials.accountId, key);
}

/**
 * Builds a Hedera client from an already-resolved key, on the configured network.
 *
 * Preferred over `hederaClient` wherever the key came from
 * `resolveSigningKey`, since that has been verified against the ledger.
 *
 * @param accountId - Operator account id
 * @param key - Private key controlling that account
 * @returns Configured client with the account set as operator
 */
export function hederaClientWithKey(accountId: string, key: PrivateKey): Client {
  assertSingleSdkInstance();
  const client = network() === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(accountId, key);
  return client;
}

export { hiero };
