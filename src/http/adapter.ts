/**
 * Bridges Node's http primitives to the HTTPAdapter interface x402 expects.
 *
 * Kept deliberately small: the demo uses Node's built-in server rather than a
 * framework so that a reader can follow the whole payment path without first
 * learning someone's middleware conventions.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type X402Adapter = {
  getHeader(name: string): string | undefined;
  getMethod(): string;
  getPath(): string;
  getUrl(): string;
  getAcceptHeader(): string;
  getUserAgent(): string;
  getQueryParams(): Record<string, string | string[]>;
  getQueryParam(name: string): string | string[] | undefined;
};

/**
 * Wraps an incoming request so x402 can read headers, method, and path from it.
 *
 * @param request - Node incoming request
 * @returns Adapter satisfying the x402 HTTPAdapter contract
 */
export function nodeAdapter(request: IncomingMessage): X402Adapter {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const header = (name: string): string | undefined => {
    const value = request.headers[name.toLowerCase()];
    return Array.isArray(value) ? value.join(", ") : value;
  };
  return {
    getHeader: header,
    getMethod: () => request.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => header("accept") ?? "",
    getUserAgent: () => header("user-agent") ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name: string) => url.searchParams.get(name) ?? undefined,
  };
}

/**
 * Writes a JSON response.
 *
 * @param response - Node server response
 * @param status - HTTP status code
 * @param body - Value to serialize
 * @param headers - Additional headers to set
 */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body ?? {}, null, 2);
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(payload);
}
