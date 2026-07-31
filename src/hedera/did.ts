/**
 * did:hedera identities, issued and resolved with the official Hiero DID SDK.
 *
 * An earlier version of this file implemented the method by hand. It produced
 * a DID string that looked right and was not: the registered `did:hedera`
 * method derives the identifier from the root public key itself, and publishes
 * DID events to HCS inside a signed envelope. Getting either wrong makes an
 * identity that no other did:hedera resolver can read, which defeats the point
 * of using a registered method at all. So this now delegates to
 * `@hiero-did-sdk/registrar` and `@hiero-did-sdk/resolver`.
 *
 * Two properties fall out of that, and both matter here:
 *
 *   1. **The DID is self-certifying.** `did:hedera:<net>:<key>_<topic>` carries
 *      the root public key in base58btc. So the key that must have signed
 *      anything this identity vouches for is recoverable from the DID string
 *      alone, with no network call and nobody to trust. The topic is a locator,
 *      not the authority.
 *
 *   2. **The identity and the Hedera account are the same key.** Every party
 *      the demo provisions is an ED25519 account whose key is also its DID root
 *      key. Nothing in the document asserts that; it is checkable against the
 *      ledger's own record of the account. See `accountKeyMatchesDid`.
 *
 * The published SDK does not load as shipped (hiero-did-sdk-js#65); the fix
 * from upstream pull request #66 is applied here through patch-package. See
 * docs/DID.md.
 */
import { createDID } from "@hiero-did-sdk/registrar";
import { TopicReaderHederaRestApi, resolveDID } from "@hiero-did-sdk/resolver";
import type { Client, PrivateKey } from "@x402/hedera";

import { mirrorNodeUrl } from "../config.js";

/** A DID Document as the SDK returns it. */
export type DidDocument = {
  id: string;
  controller: string;
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase?: string;
    publicKeyBase58?: string;
  }>;
  authentication?: unknown[];
  assertionMethod?: unknown[];
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
};

export type IssuedDid = {
  readonly did: string;
  readonly topicId: string;
  readonly accountId: string;
  /** Raw 32-byte Ed25519 root public key, hex. */
  readonly publicKey: string;
  readonly document: DidDocument;
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decodes base58btc.
 *
 * Hand-rolled rather than pulled in as a dependency because the browser viewer
 * needs the identical routine with no build step, and one implementation both
 * sides are tested against is worth more than two convenient ones.
 *
 * @param input - base58btc string
 * @returns Decoded bytes, or null when the input contains a character outside
 *          the alphabet. Null rather than a throw: this runs over strings
 *          anyone can put on a public topic.
 */
export function base58Decode(input: string): Uint8Array | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const bytes: number[] = [0];
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += (bytes[i] as number) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1's are leading zero bytes, by definition of the encoding.
  for (let i = 0; i < input.length && input[i] === "1"; i += 1) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The Ed25519 root public key a DID string commits to.
 *
 * This is the self-certifying property in one function: given only the DID, the
 * key that must have signed for it is known. A document claiming this DID under
 * a different key is a forgery regardless of who published it or where.
 *
 * @param did - DID string
 * @returns Raw 32-byte public key as hex, or null when the DID is malformed
 */
export function rootKeyFromDid(did: string): string | null {
  const match = /^did:hedera:(?:mainnet|testnet|previewnet):([^_\s]+)_(\d+\.\d+\.\d+)$/.exec(
    String(did ?? "").trim(),
  );
  if (!match) return null;
  const decoded = base58Decode(match[1] as string);
  if (!decoded || decoded.length !== 32) return null;
  return toHex(decoded);
}

/**
 * The raw public key inside a `publicKeyMultibase` value.
 *
 * Multibase 'z' prefix, then base58btc over a multicodec-prefixed key. Ed25519
 * public keys carry the varint prefix 0xed 0x01.
 *
 * @param multibase - publicKeyMultibase from a verification method
 * @returns Raw 32-byte public key as hex, or null when it is not a well-formed
 *          Ed25519 multibase key
 */
export function multibaseToHex(multibase: string): string | null {
  const value = String(multibase ?? "").trim();
  if (!value.startsWith("z")) return null;
  const decoded = base58Decode(value.slice(1));
  if (!decoded || decoded.length !== 34) return null;
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) return null;
  return toHex(decoded.subarray(2));
}

/**
 * The root key a resolved document publishes, as hex.
 *
 * @param document - Resolved DID Document
 * @returns Raw public key hex, or null when the document carries no readable
 *          Ed25519 verification method
 */
export function documentRootKeyHex(document: DidDocument | null): string | null {
  const method = document?.verificationMethod?.[0];
  if (!method) return null;
  if (method.publicKeyMultibase) return multibaseToHex(method.publicKeyMultibase);
  if (method.publicKeyBase58) {
    const decoded = base58Decode(method.publicKeyBase58);
    return decoded && decoded.length === 32 ? toHex(decoded) : null;
  }
  return null;
}

/**
 * Whether a document's published key is the key its DID commits to.
 *
 * Resolution never trusts the topic it reads from. A document claiming a DID
 * proves nothing on its own, whoever published it and wherever it sits, so this
 * is the check that decides. See docs/DID.md.
 *
 * @param did - DID being resolved
 * @param document - Document claiming to describe it
 * @returns True when the document's root key regenerates exactly this DID
 */
export function documentMatchesDid(did: string, document: DidDocument | null): boolean {
  const expected = rootKeyFromDid(did);
  const actual = documentRootKeyHex(document);
  return expected !== null && actual !== null && expected === actual;
}

/**
 * Extracts the HCS topic id embedded in a DID string.
 *
 * @param did - DID string
 * @returns Topic id, or null when the DID is malformed
 */
export function topicIdFromDid(did: string): string | null {
  const match = /_(\d+\.\d+\.\d+)$/.exec(String(did ?? "").trim());
  return match?.[1] ?? null;
}

/** Network segment of a DID string, e.g. "testnet". */
export function networkFromDid(did: string): string | null {
  const match = /^did:hedera:([^:]+):/.exec(String(did ?? "").trim());
  return match?.[1] ?? null;
}

/**
 * Issues a did:hedera identity for a party, on its own HCS topic.
 *
 * The private key given here becomes the DID root key. Passing the party's own
 * Hedera account key is deliberate: it makes "who got paid" and "who is
 * identified" the same key, checkable against the ledger.
 *
 * @param client - Hedera client, operated by the account paying the fees
 * @param args - Identity details
 * @param args.accountId - Account this identity belongs to
 * @param args.privateKey - ED25519 key controlling that account
 * @param args.role - Human-readable role, used in error messages
 * @returns The issued DID, its topic, and the published document
 */
export async function issueDid(
  client: Client,
  args: { accountId: string; privateKey: PrivateKey; role: string },
): Promise<IssuedDid> {
  const publicKeyHex = args.privateKey.publicKey.toStringRaw();
  if (publicKeyHex.length !== 64) {
    throw new Error(
      `The key for the ${args.role} is not ED25519 (its public key is ${publicKeyHex.length / 2} bytes). ` +
        "did:hedera root keys are Ed25519. See docs/DID.md.",
    );
  }

  const result = await createDID({ privateKey: args.privateKey }, { client });
  const topicId = topicIdFromDid(result.did);
  if (!topicId) {
    throw new Error(`The registrar returned a DID with no topic id: ${result.did}`);
  }

  return {
    did: result.did,
    topicId,
    accountId: args.accountId,
    publicKey: publicKeyHex,
    document: result.didDocument as DidDocument,
  };
}

/**
 * Resolves a DID through the public mirror node REST API.
 *
 * Deliberately the REST reader rather than a Hedera client: resolution should
 * need nothing but a DID string and a public endpoint, so a third party can
 * check these identities without running any of this.
 *
 * @param did - DID string to resolve
 * @returns The resolved document, or null when it cannot be resolved or does
 *          not certify itself against the DID
 */
export async function resolveDid(did: string): Promise<DidDocument | null> {
  if (!rootKeyFromDid(did)) return null;
  try {
    const document = (await resolveDID(did, "application/did+json", {
      topicReader: new TopicReaderHederaRestApi(),
    })) as DidDocument;
    return documentMatchesDid(did, document) ? document : null;
  } catch {
    return null;
  }
}

/**
 * Whether a Hedera account is controlled by the key a DID commits to.
 *
 * This is the binding between identity and money, and it is established from
 * the ledger rather than from anything the identity says about itself. The
 * account's key is public record on the mirror node; the DID's root key is in
 * the DID string. Either they are the same key or that identity does not
 * control that account.
 *
 * Failing to reach the mirror node is reported separately from reading it and
 * finding a different key. Both fail closed, but conflating them would have the
 * demo assert an impersonation it never actually established.
 *
 * @param did - DID claimed by a party
 * @param accountId - Hedera account the claim is about
 * @returns The comparison, including both keys so a caller can report it
 */
export async function accountKeyMatchesDid(
  did: string,
  accountId: string,
): Promise<{
  matches: boolean;
  reachable: boolean;
  didKey: string | null;
  accountKey: string | null;
  accountKeyType: string | null;
}> {
  const didKey = rootKeyFromDid(did);
  let reachable = false;
  let accountKey: string | null = null;
  let accountKeyType: string | null = null;
  try {
    const response = await fetch(`${mirrorNodeUrl()}/api/v1/accounts/${accountId}?limit=1`);
    if (response.ok) {
      reachable = true;
      const info = (await response.json()) as { key?: { key?: string; _type?: string } };
      accountKeyType = info.key?._type ?? null;
      if (info.key?._type === "ED25519" && info.key.key) {
        accountKey = info.key.key.toLowerCase();
      }
    }
  } catch {
    reachable = false;
  }
  return {
    matches: didKey !== null && accountKey !== null && didKey === accountKey,
    reachable,
    didKey,
    accountKey,
    accountKeyType,
  };
}
