/**
 * The HTTP adapter feeds x402's payment gate. If it reports the wrong path or
 * drops the payment header, the gate misbehaves in ways that look like
 * protocol bugs.
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { nodeAdapter } from "../src/http/adapter.js";

function request(url: string, headers: Record<string, string | string[]> = {}): IncomingMessage {
  return {
    url,
    method: "GET",
    headers: { host: "127.0.0.1:4021", ...headers },
  } as unknown as IncomingMessage;
}

describe("nodeAdapter", () => {
  it("reports the path without the query string", () => {
    expect(nodeAdapter(request("/snapshot?account=0.0.2")).getPath()).toBe("/snapshot");
  });

  it("reports the method", () => {
    expect(nodeAdapter(request("/snapshot")).getMethod()).toBe("GET");
  });

  it("reads headers case-insensitively", () => {
    const adapter = nodeAdapter(request("/snapshot", { "payment-signature": "abc" }));
    expect(adapter.getHeader("PAYMENT-SIGNATURE")).toBe("abc");
    expect(adapter.getHeader("payment-signature")).toBe("abc");
  });

  it("returns undefined for an absent header", () => {
    expect(nodeAdapter(request("/snapshot")).getHeader("PAYMENT-SIGNATURE")).toBeUndefined();
  });

  it("joins repeated headers rather than returning an array", () => {
    const adapter = nodeAdapter(request("/snapshot", { "x-multi": ["a", "b"] }));
    expect(adapter.getHeader("x-multi")).toBe("a, b");
  });

  it("extracts query parameters", () => {
    const adapter = nodeAdapter(request("/snapshot?account=0.0.2&other=x"));
    expect(adapter.getQueryParam("account")).toBe("0.0.2");
    expect(adapter.getQueryParams()).toMatchObject({ account: "0.0.2", other: "x" });
  });

  it("returns undefined for a missing query parameter", () => {
    expect(nodeAdapter(request("/snapshot")).getQueryParam("account")).toBeUndefined();
  });

  it("url-decodes query parameters", () => {
    expect(nodeAdapter(request("/snapshot?account=0.0.2%20")).getQueryParam("account")).toBe(
      "0.0.2 ",
    );
  });

  it("survives a missing url", () => {
    const bare = { method: "GET", headers: {} } as unknown as IncomingMessage;
    expect(nodeAdapter(bare).getPath()).toBe("/");
  });

  it("defaults accept and user-agent to empty strings", () => {
    const adapter = nodeAdapter(request("/snapshot"));
    expect(adapter.getAcceptHeader()).toBe("");
    expect(adapter.getUserAgent()).toBe("");
  });
});

