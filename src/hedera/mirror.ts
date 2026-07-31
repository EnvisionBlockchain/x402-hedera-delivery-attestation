/**
 * Hedera mirror node REST helpers.
 *
 * The mirror node is the demo's independent source of truth. The seller reads
 * it to build the resource, and the verifier reads it again to decide whether
 * what came back was real. Neither trusts the other.
 */
import { mirrorNodeUrl } from "../config.js";
import { toHbar } from "./units.js";

async function getJson<T>(path: string): Promise<T> {
  const url = `${mirrorNodeUrl()}${path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Mirror node ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

/**
 * Fetches JSON while preserving integers too large for a JS double.
 *
 * Hedera balances are tinybars and routinely exceed 2^53, where doubles are
 * spaced 512 apart. `JSON.parse` silently rounds them: the live treasury
 * balance 3403292018892156130 comes back as 3403292018892156000. Both the
 * seller and the verifier would round identically, so the demo would still
 * agree with itself while publishing a number that is not the real on-chain
 * balance.
 *
 * Long integer literals are quoted before parsing so they survive as strings.
 * Deliberately not used for endpoints carrying base64 or free text, where a
 * digit run inside a string value could be rewritten by mistake.
 *
 * @param path - Mirror node path
 * @returns Parsed body with long integers as strings
 */
async function getJsonPreservingLargeIntegers<T>(path: string): Promise<T> {
  const url = `${mirrorNodeUrl()}${path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Mirror node ${response.status} for ${url}`);
  }
  const text = await response.text();
  return JSON.parse(
    text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'),
  ) as T;
}

export type BalanceSnapshot = {
  readonly snapshotTimestamp: string;
  /** Exact HBAR amount as a decimal string. Never a number: these exceed 2^53. */
  readonly balanceHbar: string;
  readonly tokenCount: number;
};

type MirrorBalancesResponse = {
  timestamp?: string;
  // balance arrives as a string when large enough to lose precision as a double.
  balances?: Array<{ account?: string; balance?: number | string; tokens?: unknown[] }>;
};

/**
 * Reads an account's balance snapshot at or before a consensus timestamp.
 *
 * Hedera records balance snapshots periodically, and each one is an immutable
 * historical fact. That is what makes this resource verifiable: the seller
 * reports the snapshot it received, and anyone can re-query that exact
 * timestamp later and get the same answer.
 *
 * @param accountId - Hedera account id
 * @param timestamp - Consensus timestamp to read at; defaults to now
 * @returns The snapshot the mirror node returned, including its own timestamp
 */
export async function readBalanceSnapshotAt(
  accountId: string,
  timestamp?: string,
): Promise<BalanceSnapshot> {
  const at = timestamp ?? (Date.now() / 1000).toFixed(9);
  const body = await getJsonPreservingLargeIntegers<MirrorBalancesResponse>(
    `/api/v1/balances?account.id=${encodeURIComponent(accountId)}&timestamp=${encodeURIComponent(at)}`,
  );
  const entry = body.balances?.[0];
  if (!entry) {
    throw new Error(`Mirror node returned no balance snapshot for ${accountId} at ${at}`);
  }
  return {
    snapshotTimestamp: String(body.timestamp ?? ""),
    // The mirror node reports tinybars; convert exactly and never look back.
    balanceHbar: toHbar(String(entry.balance ?? 0)),
    tokenCount: Array.isArray(entry.tokens) ? entry.tokens.length : 0,
  };
}

/**
 * Converts a Hedera transaction id to the form the REST API expects.
 *
 * `0.0.7162784@1785359933.051441057` becomes
 * `0.0.7162784-1785359933-051441057`. The nanosecond field is captured as a
 * string so leading zeros survive; converting it through a number would silently
 * produce a different transaction.
 *
 * @param transactionId - Transaction id in `account@seconds.nanos` form
 * @returns REST path segment, or null when the id is malformed
 */
export function transactionIdToRestPath(transactionId: string): string | null {
  const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(String(transactionId ?? "").trim());
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export type ConfirmedTransaction = {
  readonly transactionId: string;
  readonly result: string;
  readonly consensusTimestamp: string;
  readonly chargedFeeHbar: string;
  readonly transfers: ReadonlyArray<{ account: string; amount: number }>;
};

type MirrorTransactionsResponse = {
  transactions?: Array<{
    transaction_id?: string;
    result?: string;
    consensus_timestamp?: string;
    charged_tx_fee?: number;
    transfers?: Array<{ account?: string; amount?: number }>;
  }>;
};

/**
 * Reads a transaction from the mirror node, waiting out ingestion lag.
 *
 * Consensus precedes mirror node availability by a second or two, so a lookup
 * issued immediately after settlement can legitimately miss. Returns null once
 * the window closes rather than throwing, so the caller decides whether an
 * unconfirmable payment is fatal.
 *
 * @param transactionId - Transaction id in `account@seconds.nanos` form
 * @param timeoutMs - How long to keep retrying before giving up
 * @returns The transaction, or null when malformed or not found in time
 */
export async function readTransaction(
  transactionId: string,
  timeoutMs = 20_000,
): Promise<ConfirmedTransaction | null> {
  const path = transactionIdToRestPath(transactionId);
  if (!path) return null;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const body = await getJson<MirrorTransactionsResponse>(`/api/v1/transactions/${path}`);
      const found = body.transactions?.[0];
      if (found) {
        return {
          transactionId: String(found.transaction_id ?? transactionId),
          result: String(found.result ?? "UNKNOWN"),
          consensusTimestamp: String(found.consensus_timestamp ?? ""),
          chargedFeeHbar: toHbar(String(found.charged_tx_fee ?? 0)),
          transfers: (found.transfers ?? []).map((t) => ({
            account: String(t.account ?? ""),
            amount: Number(t.amount ?? 0),
          })),
        };
      }
    } catch {
      // Not ingested yet, or a transient error. Retry until the deadline.
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export type TopicMessage = {
  readonly sequenceNumber: number;
  readonly consensusTimestamp: string;
  readonly contents: string;
};

type MirrorTopicMessagesResponse = {
  messages?: Array<{
    sequence_number?: number;
    consensus_timestamp?: string;
    message?: string;
  }>;
  links?: { next?: string | null };
};

/**
 * Pages the mirror node will follow before giving up.
 *
 * At 100 messages a page this is 2000 messages, far past any demo topic. It
 * bounds the work, not the truth: `readTopicMessages` reports hitting it rather
 * than returning a short answer that looks complete.
 */
const MAX_TOPIC_PAGES = 20;

/**
 * Reads messages published to an HCS topic, oldest first.
 *
 * Used to read back delivery attestations, and readable by a third party with
 * no access to this repo's running services.
 *
 * The mirror node caps a page at 100 messages and returns `links.next` when
 * there are more, so this follows that chain. Reading one page and stopping
 * would present the oldest hundred as the whole ledger, which on a reputation
 * count reads as "this seller has a clean record" rather than as "you were
 * shown a hundred of them".
 *
 * @param topicId - HCS topic id, e.g. "0.0.12345"
 * @param pageSize - Messages per request; the mirror node caps this at 100
 * @returns Decoded messages in consensus order. `truncated` is true when the
 *          page limit was reached before the topic ran out, so a caller can
 *          say so rather than present a partial ledger as a whole one.
 */
export async function readTopicMessages(
  topicId: string,
  pageSize = 100,
): Promise<{ messages: TopicMessage[]; truncated: boolean }> {
  const messages: TopicMessage[] = [];
  let path: string | null =
    `/api/v1/topics/${encodeURIComponent(topicId)}/messages?limit=${pageSize}&order=asc`;
  let pages = 0;

  while (path) {
    if (pages >= MAX_TOPIC_PAGES) return { messages, truncated: true };
    const body: MirrorTopicMessagesResponse =
      await getJson<MirrorTopicMessagesResponse>(path);
    for (const message of body.messages ?? []) {
      messages.push({
        sequenceNumber: Number(message.sequence_number ?? 0),
        consensusTimestamp: String(message.consensus_timestamp ?? ""),
        contents: Buffer.from(String(message.message ?? ""), "base64").toString("utf8"),
      });
    }
    pages += 1;
    path = body.links?.next ?? null;
  }

  return { messages, truncated: false };
}

/**
 * Waits for a topic to have at least `count` messages.
 *
 * Mirror node ingestion lags consensus by a second or two, so a read issued
 * immediately after a submit can legitimately come back empty.
 *
 * @param topicId - HCS topic id
 * @param count - Minimum number of messages to wait for
 * @param timeoutMs - How long to keep trying before giving up
 * @returns The messages once available
 */
export async function waitForTopicMessages(
  topicId: string,
  count: number,
  timeoutMs = 30_000,
): Promise<TopicMessage[]> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const { messages } = await readTopicMessages(topicId);
      if (messages.length >= count) return messages;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `Timed out waiting for ${count} message(s) on topic ${topicId} after ${timeoutMs}ms.` +
      (lastError ? ` Last error: ${String(lastError)}` : ""),
  );
}
