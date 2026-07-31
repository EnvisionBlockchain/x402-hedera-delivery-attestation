/**
 * Provisions everything the demo needs, from one funded account.
 *
 * Creates three accounts (honest seller, dishonest seller, verifier) from the
 * buyer's account, issues a did:hedera identity for all four parties, and
 * creates the shared attestation topic, then writes it all to .env.
 *
 * Asking a stranger to create four accounts by hand would be the most likely
 * place they give up, so the only manual step is one account from the portal.
 */
import { AccountCreateTransaction, Hbar, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { PrivateKey } from "@x402/hedera";

import {
  credentials,
  hashscanAccount,
  hashscanTopic,
  network,
  networkBanner,
} from "../src/config.js";
import { ENV_PATH, readEnvFile, updateEnvFile } from "../src/envfile.js";
import { assertSingleSdkInstance, hederaClientWithKey, resolveSigningKey } from "../src/hedera/client.js";
import { issueDid } from "../src/hedera/did.js";

/**
 * HBAR each provisioned account starts with.
 *
 * Measured, not guessed: a seller spends nothing (it is paid, and the
 * facilitator pays the transfer fee), and the verifier spends roughly 0.013
 * HBAR per attestation it publishes. One HBAR is therefore many hundreds of
 * demo runs, and leaving faucet balance in the operator account is the polite
 * default when the faucet is a shared resource.
 */
const INITIAL_BALANCE_HBAR = 1;

type Party = {
  readonly envPrefix: "BUYER" | "SELLER" | "MOCK_SELLER" | "VERIFIER";
  readonly role: string;
  accountId: string;
  /** Key controlling the Hedera account. */
  privateKey: PrivateKey;
  /**
   * Key that becomes the DID root key.
   *
   * The same object as `privateKey` for every account this script creates, so
   * identity and payment are one key. It differs only for a buyer whose
   * operator account came from the portal as ECDSA, which cannot be a
   * did:hedera root key.
   */
  didKey: PrivateKey;
};

async function main(): Promise<void> {
  assertSingleSdkInstance();
  const net = network();

  const buyer = credentials.buyer();
  const buyerKey = await resolveSigningKey(buyer.accountId, buyer.privateKey, buyer.label);
  const client = hederaClientWithKey(buyer.accountId, buyerKey);

  console.log(`Bootstrapping the demo on Hedera ${net}`);
  console.log(`  ${networkBanner()}`);
  console.log(`  operator: ${buyer.accountId} (pays for everything below)\n`);

  // A did:hedera root key is Ed25519. The operator's account came from the
  // portal and may be either curve, so the buyer gets a dedicated identity key
  // only when its account key cannot serve as one. That case is called out
  // rather than hidden, because it is the one party whose identity and payment
  // keys are not the same key.
  const buyerKeyIsEd25519 = buyerKey.publicKey.toStringRaw().length === 64;
  const buyerDidKey = buyerKeyIsEd25519 ? buyerKey : PrivateKey.generateED25519();

  const parties: Party[] = [
    {
      envPrefix: "BUYER",
      role: "buyer agent",
      accountId: buyer.accountId,
      privateKey: buyerKey,
      didKey: buyerDidKey,
    },
  ];

  // --- Create the three accounts the operator does not already have ---------
  // ED25519 throughout: it is what did:hedera root keys must be, and it settles
  // x402 payments on Hedera exactly as ECDSA does. Using one curve for both
  // roles is what lets a party's identity and its account be the same key.
  const toCreate: Array<{ envPrefix: Party["envPrefix"]; role: string }> = [
    { envPrefix: "SELLER", role: "honest seller" },
    { envPrefix: "MOCK_SELLER", role: "dishonest seller (deliberate mock)" },
    { envPrefix: "VERIFIER", role: "delivery verifier" },
  ];

  for (const spec of toCreate) {
    const key = PrivateKey.generateED25519();
    const receipt = await (
      await new AccountCreateTransaction()
        .setKeyWithoutAlias(key.publicKey)
        .setInitialBalance(new Hbar(INITIAL_BALANCE_HBAR))
        .execute(client)
    ).getReceipt(client);

    const accountId = receipt.accountId?.toString();
    if (!accountId) throw new Error(`Account creation for the ${spec.role} returned no account id.`);

    console.log(`  created ${spec.role}: ${accountId} (${INITIAL_BALANCE_HBAR} HBAR, ED25519)`);
    parties.push({ ...spec, accountId, privateKey: key, didKey: key });
  }

  // --- Issue a did:hedera identity for each party --------------------------
  console.log("\nIssuing did:hedera identities with the Hiero DID SDK (one HCS topic each)\n");
  const issued: Array<{ party: Party; did: string; topicId: string }> = [];

  for (const party of parties) {
    const result = await issueDid(client, {
      accountId: party.accountId,
      privateKey: party.didKey,
      role: party.role,
    });
    const sameKey = party.didKey === party.privateKey;
    console.log(`  ${party.role}`);
    console.log(`    did   : ${result.did}`);
    console.log(`    topic : ${hashscanTopic(result.topicId)}`);
    console.log(
      `    key   : ${
        sameKey
          ? `root key is also the key controlling ${party.accountId}`
          : `identity-only key; ${party.accountId} is an ECDSA account and cannot share it`
      }`,
    );
    issued.push({ party, did: result.did, topicId: result.topicId });
  }

  // --- Shared attestation topic --------------------------------------------
  const attestationReceipt = await (
    await new TopicCreateTransaction()
      .setTopicMemo("x402 delivery attestations")
      .execute(client)
  ).getReceipt(client);
  const attestationTopicId = attestationReceipt.topicId?.toString();
  if (!attestationTopicId) throw new Error("Attestation topic creation returned no topic id.");

  console.log(`\nShared attestation topic: ${attestationTopicId}`);
  console.log(`  ${hashscanTopic(attestationTopicId)}`);

  // --- Persist, rather than asking a human to copy it back -----------------
  const updates: Record<string, string> = { ATTESTATION_TOPIC_ID: attestationTopicId };
  for (const { party, did } of issued) {
    updates[`${party.envPrefix}_DID`] = did;
    if (party.envPrefix !== "BUYER") {
      updates[`${party.envPrefix}_ACCOUNT_ID`] = party.accountId;
      updates[`${party.envPrefix}_PRIVATE_KEY`] = party.privateKey.toStringDer();
    } else if (party.didKey !== party.privateKey) {
      updates.BUYER_DID_PRIVATE_KEY = party.didKey.toStringDer();
    }
  }
  // Keep whatever credentials the operator supplied, however they supplied them.
  if (!readEnvFile(ENV_PATH).BUYER_ACCOUNT_ID) {
    updates.BUYER_ACCOUNT_ID = buyer.accountId;
    updates.BUYER_PRIVATE_KEY = buyer.privateKey;
  }
  updateEnvFile(updates, ENV_PATH);

  console.log(`\nWrote ${Object.keys(updates).length} values to ${ENV_PATH}. Nothing to copy.`);
  console.log("\nAccounts:");
  for (const { party } of issued) {
    console.log(`  ${party.role.padEnd(36)} ${hashscanAccount(party.accountId)}`);
  }

  client.close();
}

main().catch((error: unknown) => {
  console.error("\nBootstrap failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
