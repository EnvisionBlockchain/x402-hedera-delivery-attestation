/**
 * The x402 payment gate, shared by both sellers.
 *
 * Both sellers import this exact module and differ only in the handler they
 * pass. That is deliberate: it makes "the payment behaved identically in both
 * cases" a structural fact about the code rather than a claim in a README.
 */
import { createServer, type Server } from "node:http";

import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import { ExactHederaScheme as ExactHederaServer } from "@x402/hedera/exact/server";

import { HBAR_ASSET, caip2Network, facilitatorUrl, priceHbar } from "../config.js";
import { toTinybars } from "../hedera/units.js";
import { nodeAdapter, sendJson } from "../http/adapter.js";

/** Demo sellers are a local half of a local demo. Never bind wider. */
const LOOPBACK = "127.0.0.1";

export const SNAPSHOT_ROUTE = "/snapshot";

/**
 * Validity window of the transaction the buyer signs, in seconds.
 *
 * The Hiero SDK default, which `@x402/hedera` does not override. Advertised as
 * `maxTimeoutSeconds` so the 402 does not promise a longer window than the
 * signed transaction will actually honour.
 */
export const TRANSACTION_VALID_SECONDS = 120;

export type SellerOptions = {
  /** Human-readable role, used in log output. */
  readonly role: string;
  /** Port to listen on. */
  readonly port: number;
  /** Hedera account that receives payment. */
  readonly payTo: string;
  /** DID this seller publishes as its identity. */
  readonly did: string;
  /**
   * Produces the response body for a paid request.
   *
   * Whatever this returns is served verbatim. The gate does not inspect it,
   * which is exactly how a real buyer's situation looks.
   */
  readonly handler: (requestedAccount: string) => Promise<unknown>;
};

export type RunningSeller = {
  readonly url: string;
  close(): Promise<void>;
};

/**
 * Starts an x402-gated seller.
 *
 * @param options - Seller configuration
 * @returns The running seller's URL and a close handle
 */
export async function startSeller(options: SellerOptions): Promise<RunningSeller> {
  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: facilitatorUrl() }),
  );
  resourceServer.register("hedera:*", new ExactHederaServer());

  const gate = new x402HTTPResourceServer(resourceServer, {
    [`GET ${SNAPSHOT_ROUTE}`]: {
      accepts: [
        {
          scheme: "exact",
          network: caip2Network(),
          // x402 requires integer atomic units on the wire. This is the only
          // place in the codebase that speaks tinybars.
          price: { amount: toTinybars(priceHbar()).toString(), asset: HBAR_ASSET },
          payTo: options.payTo,
          // Match the validity window of the transaction the buyer actually
          // signs. @x402/hedera sets no custom duration, so the Hiero SDK
          // default of 120s applies. Core would otherwise advertise 300s, which
          // promises a window the signed transaction does not honour.
          maxTimeoutSeconds: TRANSACTION_VALID_SECONDS,
        },
      ],
      // The seller advertises its identity up front, before any money moves.
      // The verifier later confirms this DID actually controls the account
      // that received the payment.
      description: `Hedera account snapshot | servedBy=${options.did}`,
      mimeType: "application/json",
    },
  });
  await gate.initialize();

  const server: Server = createServer((request, response) => {
    void (async () => {
      const adapter = nodeAdapter(request);
      if (adapter.getPath() !== SNAPSHOT_ROUTE) {
        sendJson(response, 404, { error: "not found", try: SNAPSHOT_ROUTE });
        return;
      }

      // The route is registered for GET. Without this, any other verb fails to
      // match the payment route, x402 reports no-payment-required, and the
      // resource would be served for free.
      if (adapter.getMethod() !== "GET") {
        sendJson(response, 405, { error: "method not allowed", allow: "GET" }, { allow: "GET" });
        return;
      }

      const result = await gate.processHTTPRequest({
        adapter,
        path: adapter.getPath(),
        method: adapter.getMethod(),
        paymentHeader: adapter.getHeader("PAYMENT-SIGNATURE"),
      });

      if (result.type === "payment-error") {
        sendJson(response, result.response.status, result.response.body, result.response.headers);
        return;
      }

      const requested = String(adapter.getQueryParam("account") ?? "");
      if (!requested) {
        sendJson(response, 400, { error: "missing required query parameter: account" });
        return;
      }

      let body: unknown;
      try {
        body = await options.handler(requested);
      } catch (error) {
        sendJson(response, 502, {
          error: "handler failed",
          detail: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (result.type === "payment-verified") {
        const settled = await gate.processSettlement(
          result.paymentPayload,
          result.paymentRequirements,
          result.declaredExtensions,
          { request: { adapter, path: adapter.getPath(), method: adapter.getMethod() } },
        );
        if (!settled.success) {
          sendJson(response, 402, { error: "settlement failed", detail: settled.errorMessage });
          return;
        }
        sendJson(response, 200, body, settled.headers);
        return;
      }

      // Every route on this seller is paid. Reaching here means the gate did
      // not engage, which is a defect rather than a free tier, so fail closed
      // instead of serving the resource.
      sendJson(response, 500, {
        error: "payment gate did not engage; refusing to serve a paid resource",
      });
    })().catch((error: unknown) => {
      sendJson(response, 500, { error: String(error) });
    });
  });

  // Without an error listener a held port surfaces as an unhandled 'error'
  // event, which kills the process with a raw EADDRINUSE stack mid-demo.
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `Port ${options.port} is already in use, so the ${options.role} could not start. ` +
                "A previous run may still be holding it; stop that process, or set the port " +
                "explicitly with HONEST_SELLER_PORT or DISHONEST_SELLER_PORT.",
            )
          : error,
      );
    });
    // Bind loopback explicitly. Without a host, Node listens on every
    // interface, so a demo seller is reachable by anyone on the same network
    // while this file's own log line claims otherwise. These sellers are
    // local halves of a local demo; nothing should reach them from off-box.
    server.listen(options.port, LOOPBACK, resolve);
  });

  // Derived from what the server actually bound to, not from a constant, so
  // the address printed here cannot drift away from the address in use.
  const bound = server.address();
  const host = typeof bound === "object" && bound !== null ? bound.address : LOOPBACK;
  const port = typeof bound === "object" && bound !== null ? bound.port : options.port;
  const url = `http://${host}:${port}${SNAPSHOT_ROUTE}`;
  console.log(`[${options.role}] listening at ${url}`);
  console.log(`[${options.role}] paid to ${options.payTo}, identified as ${options.did}`);

  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
