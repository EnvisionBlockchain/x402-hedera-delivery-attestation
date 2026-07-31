/**
 * Mirror node parsing. This is the demo's independent source of truth, so a
 * silent parsing mistake here would make every verdict meaningless while
 * looking perfectly healthy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { toHbar } from "../src/hedera/units.js";
import {
  readBalanceSnapshotAt,
  readTransaction,
  transactionIdToRestPath,
  readTopicMessages,
  waitForTopicMessages,
} from "../src/hedera/mirror.js";

function mockFetch(handler: (url: string) => { ok?: boolean; status?: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const result = handler(String(url));
      const text = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
      return {
        ok: result.ok ?? true,
        status: result.status ?? 200,
        json: async () => JSON.parse(text),
        text: async () => text,
      };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});


describe("readBalanceSnapshotAt", () => {
  it("reports the snapshot timestamp the mirror node returned, not the one requested", async () => {
    // The mirror node answers with the most recent snapshot at or before the
    // requested time. Reporting the requested time would make the record
    // unverifiable by a third party.
    mockFetch(() => ({
      body: { timestamp: "1785349071.906545104", balances: [{ balance: 100, tokens: [] }] },
    }));
    const snapshot = await readBalanceSnapshotAt("0.0.2", "1785349881.156836231");
    expect(snapshot.snapshotTimestamp).toBe("1785349071.906545104");
    expect(snapshot.balanceHbar).toBe("0.000001");
  });

  it("passes the requested timestamp through to the query", async () => {
    const spy = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ timestamp: "1", balances: [{ balance: 0, tokens: [] }] }),
      text: async () => '{"timestamp":"1","balances":[{"balance":0,"tokens":[]}]}',
    }));
    vi.stubGlobal("fetch", spy);
    await readBalanceSnapshotAt("0.0.2", "1785349881.156836231");
    expect(String(spy.mock.calls[0]?.[0])).toContain("timestamp=1785349881.156836231");
  });

  it("counts tokens", async () => {
    mockFetch(() => ({ body: { timestamp: "1", balances: [{ balance: 5, tokens: [{}, {}, {}] }] } }));
    expect((await readBalanceSnapshotAt("0.0.2")).tokenCount).toBe(3);
  });

  it("throws when no snapshot exists for the account", async () => {
    mockFetch(() => ({ body: { timestamp: "1", balances: [] } }));
    await expect(readBalanceSnapshotAt("0.0.2")).rejects.toThrow(/no balance snapshot/i);
  });

  // Regression: JSON.parse rounds integers past 2^53. Doubles near 3.4e18 are
  // spaced 512 apart, so the live treasury balance came back 130 tinybars wrong.
  it("preserves a balance too large to survive a JS double", async () => {
    mockFetch(() => ({
      body:
        '{"timestamp":"1785.1","balances":[{"account":"0.0.2","balance":3403292018892156130,"tokens":[]}]}',
    }));
    expect((await readBalanceSnapshotAt("0.0.2")).balanceHbar).toBe("34032920188.9215613");
  });

  it("preserves other values that a double would round", async () => {
    for (const exact of ["9007199254740993", "1000000000000000001", "3403307618892155401"]) {
      mockFetch(() => ({
        body: `{"timestamp":"1","balances":[{"account":"0.0.2","balance":${exact},"tokens":[]}]}`,
      }));
      expect((await readBalanceSnapshotAt("0.0.2")).balanceHbar).toBe(toHbar(exact));
    }
  });

  it("leaves small balances alone", async () => {
    mockFetch(() => ({ body: '{"timestamp":"1","balances":[{"balance":42,"tokens":[]}]}' }));
    expect((await readBalanceSnapshotAt("0.0.2")).balanceHbar).toBe("0.00000042");
  });

  it("does not corrupt timestamps, which are dotted and must stay strings", async () => {
    mockFetch(() => ({
      body: '{"timestamp":"1785349071.906545104","balances":[{"balance":1,"tokens":[]}]}',
    }));
    expect((await readBalanceSnapshotAt("0.0.2")).snapshotTimestamp).toBe("1785349071.906545104");
  });
});

describe("readTopicMessages", () => {
  it("base64-decodes message contents", async () => {
    mockFetch(() => ({
      body: {
        messages: [
          {
            sequence_number: 1,
            consensus_timestamp: "1785.1",
            message: Buffer.from('{"hello":"world"}', "utf8").toString("base64"),
          },
        ],
      },
    }));
    const { messages, truncated } = await readTopicMessages("0.0.5");
    expect(messages[0]?.contents).toBe('{"hello":"world"}');
    expect(messages[0]?.sequenceNumber).toBe(1);
    expect(truncated).toBe(false);
  });

  it("requests ascending order so consensus order is preserved", async () => {
    const spy = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
    }));
    vi.stubGlobal("fetch", spy);
    await readTopicMessages("0.0.5");
    expect(String(spy.mock.calls[0]?.[0])).toContain("order=asc");
  });

  it("returns an empty array for a topic with no messages", async () => {
    mockFetch(() => ({ body: {} }));
    expect((await readTopicMessages("0.0.5")).messages).toEqual([]);
  });

  it("handles utf8 beyond ascii", async () => {
    mockFetch(() => ({
      body: {
        messages: [{ sequence_number: 1, message: Buffer.from("héllo ✅", "utf8").toString("base64") }],
      },
    }));
    expect((await readTopicMessages("0.0.5")).messages[0]?.contents).toBe("héllo ✅");
  });

  it("throws on a non-ok response", async () => {
    mockFetch(() => ({ ok: false, status: 500, body: {} }));
    await expect(readTopicMessages("0.0.5")).rejects.toThrow(/500/);
  });

  // The mirror node caps a page at 100 messages and hands back links.next when
  // there are more. Reading one page and stopping would present the oldest
  // hundred as the whole ledger, and a reputation count built on that reads as
  // "clean record" rather than "you were shown part of it".
  it("follows links.next until the topic runs out", async () => {
    const page = (seq: number, text: string, next: string | null) => ({
      messages: [
        {
          sequence_number: seq,
          consensus_timestamp: `${seq}.0`,
          message: Buffer.from(text, "utf8").toString("base64"),
        },
      ],
      links: { next },
    });
    const pages = [
      page(1, "one", "/api/v1/topics/0.0.5/messages?page=2"),
      page(2, "two", "/api/v1/topics/0.0.5/messages?page=3"),
      page(3, "three", null),
    ];
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => pages[spy.mock.calls.length - 1],
    }));
    vi.stubGlobal("fetch", spy);

    const { messages, truncated } = await readTopicMessages("0.0.5");
    expect(messages.map((m) => m.contents)).toEqual(["one", "two", "three"]);
    expect(messages.map((m) => m.sequenceNumber)).toEqual([1, 2, 3]);
    expect(truncated).toBe(false);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  // A topic that never reports running out. Without a bound this never returns,
  // so the bound has to exist; the point of the test is that hitting it is
  // reported rather than passed off as the whole topic.
  it("stops at the page cap and reports that it did", async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [
          {
            sequence_number: spy.mock.calls.length,
            consensus_timestamp: `${spy.mock.calls.length}.0`,
            message: Buffer.from("x", "utf8").toString("base64"),
          },
        ],
        links: { next: "/api/v1/topics/0.0.5/messages?page=next" },
      }),
    }));
    vi.stubGlobal("fetch", spy);

    const { messages, truncated } = await readTopicMessages("0.0.5");
    expect(truncated).toBe(true);
    expect(messages).toHaveLength(20);
  });
});

describe("waitForTopicMessages", () => {
  it("returns immediately when enough messages are already present", async () => {
    mockFetch(() => ({
      body: {
        messages: [
          { sequence_number: 1, message: Buffer.from("a").toString("base64") },
          { sequence_number: 2, message: Buffer.from("b").toString("base64") },
        ],
      },
    }));
    expect(await waitForTopicMessages("0.0.5", 2)).toHaveLength(2);
  });

  it("gives up with a message naming the topic and the wait", async () => {
    mockFetch(() => ({ body: { messages: [] } }));
    await expect(waitForTopicMessages("0.0.5", 1, 0)).rejects.toThrow(/0\.0\.5/);
  });
});

describe("transactionIdToRestPath", () => {
  it("converts the account@seconds.nanos form to the dashed REST form", () => {
    expect(transactionIdToRestPath("0.0.7162784@1785359933.051441057")).toBe(
      "0.0.7162784-1785359933-051441057",
    );
  });

  // The nanosecond field is captured as a string on purpose. Routing it through
  // a number would drop the leading zero and address a different transaction.
  it("preserves leading zeros in the nanosecond field", () => {
    expect(transactionIdToRestPath("0.0.1@1785359933.000000007")).toBe(
      "0.0.1-1785359933-000000007",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(transactionIdToRestPath("  0.0.1@2.3  ")).toBe("0.0.1-2-3");
  });

  it.each([
    ["empty", ""],
    ["no at sign", "0.0.1-2-3"],
    ["missing nanos", "0.0.1@2"],
    ["not an id", "hello"],
    ["already converted", "0.0.1-1785359933-051441057"],
  ])("returns null for %s", (_label, input) => {
    expect(transactionIdToRestPath(input)).toBeNull();
  });
});

describe("readTransaction", () => {
  const TX = "0.0.7162784@1785359933.051441057";

  it("normalizes a confirmed transaction", async () => {
    mockFetch(() => ({
      body: {
        transactions: [
          {
            transaction_id: TX,
            result: "SUCCESS",
            consensus_timestamp: "1785359940.000000000",
            charged_tx_fee: 296864,
            transfers: [
              { account: "0.0.9929", amount: -1000000 },
              { account: "0.0.9832130", amount: 1000000 },
            ],
          },
        ],
      },
    }));
    const tx = await readTransaction(TX, 0);
    expect(tx?.result).toBe("SUCCESS");
    expect(tx?.chargedFeeHbar).toBe("0.00296864");
    expect(tx?.transfers).toHaveLength(2);
  });

  it("reports a non-SUCCESS result rather than treating it as absent", async () => {
    mockFetch(() => ({ body: { transactions: [{ result: "INVALID_SIGNATURE" }] } }));
    expect((await readTransaction(TX, 0))?.result).toBe("INVALID_SIGNATURE");
  });

  it("returns null for a malformed id without touching the network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await readTransaction("nonsense", 0)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null when the transaction is absent once the window closes", async () => {
    mockFetch(() => ({ body: { transactions: [] } }));
    expect(await readTransaction(TX, 0)).toBeNull();
  });

  it("returns null rather than throwing when the mirror node errors", async () => {
    mockFetch(() => ({ ok: false, status: 503, body: {} }));
    expect(await readTransaction(TX, 0)).toBeNull();
  });
});
