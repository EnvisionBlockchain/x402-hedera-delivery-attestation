/**
 * Walk-away gate.
 *
 * Proves one thing and nothing else: that a single x402 `exact` payment can be
 * made on Hedera testnet through the configured facilitator, and that it lands
 * on chain with a transaction id you can open on HashScan.
 *
 * Nothing else in this repo is worth building if this does not pass. Run it
 * first.
 */
import { createServer } from "node:http";

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme as ExactHederaClient } from "@x402/hedera/exact/client";
import { ExactHederaScheme as ExactHederaServer } from "@x402/hedera/exact/server";

import {
  caip2Network,
  HBAR_ASSET,
  credentials,
  facilitatorUrl,
  hashscanTx,
  network,
  networkBanner,
  payToAccountId,
  ports,
  priceHbar,
} from "../src/config.js";
import { assertFacilitatorMatchesNetwork } from "../src/facilitator.js";
import { TRANSACTION_VALID_SECONDS } from "../src/seller/gate.js";
import { assertSingleSdkInstance, resolveSigningKey } from "../src/hedera/client.js";
import { toTinybars } from "../src/hedera/units.js";
import { nodeAdapter, sendJson } from "../src/http/adapter.js";

const ROUTE = "/smoke";

async function main(): Promise<void> {
  assertSingleSdkInstance();
  await assertFacilitatorMatchesNetwork();

  const buyer = credentials.buyer();
  const sellerPayTo = payToAccountId();
  const price = priceHbar();

  // Never hardcode the network here. This script signs and submits a real
  // transfer, so on mainnet a banner asserting "testnet" would be the last
  // thing a reader saw before spending real HBAR.
  console.log(`x402 on Hedera ${network()}: smoke test`);
  console.log(`  ${networkBanner()}`);
  console.log(`  facilitator : ${facilitatorUrl()}`);
  console.log(`  buyer       : ${buyer.accountId}`);
  console.log(`  payTo       : ${sellerPayTo}`);
  console.log(`  price       : ${price} HBAR (asset ${HBAR_ASSET})`);
  console.log("");

  // --- Seller side ---------------------------------------------------------
  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: facilitatorUrl() }),
  );
  resourceServer.register("hedera:*", new ExactHederaServer());

  const gate = new x402HTTPResourceServer(resourceServer, {
    [`GET ${ROUTE}`]: {
      accepts: [
        {
          scheme: "exact",
          network: caip2Network(),
          price: { amount: toTinybars(price).toString(), asset: HBAR_ASSET },
          payTo: sellerPayTo,
          // Must match the window the buyer's transaction is actually frozen
          // for. Omitting it lets core advertise its 300s default against a
          // transaction the Hiero SDK freezes for 120s, promising a window that
          // does not exist. src/seller/gate.ts sets the same value; this file
          // keeps its own copy because it is deliberately standalone.
          maxTimeoutSeconds: TRANSACTION_VALID_SECONDS,
        },
      ],
      description: "Smoke test resource",
      mimeType: "application/json",
    },
  });
  await gate.initialize();

  const server = createServer((request, response) => {
    void (async () => {
      const adapter = nodeAdapter(request);
      if (adapter.getPath() !== ROUTE) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      if (adapter.getMethod() !== "GET") {
        sendJson(response, 405, { error: "method not allowed", allow: "GET" });
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

      const body = { ok: true, resource: "smoke", servedAt: new Date().toISOString() };

      if (result.type === "payment-verified") {
        const settled = await gate.processSettlement(
          result.paymentPayload,
          result.paymentRequirements,
          result.declaredExtensions,
          { request: { adapter, path: adapter.getPath(), method: adapter.getMethod() } },
        );
        if (!settled.success) {
          sendJson(response, 502, { error: "settlement failed", detail: settled });
          return;
        }
        console.log(`  settled: ${settled.transaction ?? "(no transaction id reported)"}`);
        sendJson(response, 200, body, settled.headers);
        return;
      }

      sendJson(response, 500, { error: "payment gate did not engage" });
    })().catch((error: unknown) => {
      console.error("seller error:", error);
      sendJson(response, 500, { error: String(error) });
    });
  });

  // Loopback explicitly. Omitting the host binds every interface, which on a
  // laptop on a shared network exposes a server that signs Hedera transactions
  // to anyone who can reach the machine. The sellers in src/seller/gate.ts bind
  // the same way, and docs/SECURITY_NOTES.md says so of this file too.
  const LOOPBACK = "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(ports.smoke, LOOPBACK, resolve));
  const bound = server.address();
  const port = typeof bound === "object" && bound !== null ? bound.port : ports.smoke;
  const url = `http://${LOOPBACK}:${port}${ROUTE}`;
  console.log(`  seller listening at ${url}`);

  try {
    // --- Buyer side --------------------------------------------------------
    // Resolve the curve against the ledger rather than trusting a label, so
    // either encoding works and a wrong key fails here rather than on chain.
    const buyerKey = await resolveSigningKey(buyer.accountId, buyer.privateKey, buyer.label);
    const signer = createClientHederaSigner(buyer.accountId, buyerKey, {
      network: caip2Network(),
    });
    const httpClient = new x402HTTPClient(
      new x402Client().register("hedera:*", new ExactHederaClient(signer)),
    );

    const unpaid = await fetch(url);
    console.log(`\n  1. unpaid request -> ${unpaid.status}`);
    if (unpaid.status !== 402) {
      throw new Error(`Expected 402 from an unpaid request, got ${unpaid.status}.`);
    }

    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => unpaid.headers.get(name),
      await unpaid.clone().json(),
    );
    console.log("  2. received payment requirements, signing transfer");
    if (process.env.DEBUG_X402) {
      console.log("\n--- payment required payload ---");
      console.log(JSON.stringify(paymentRequired, null, 2));
      console.log("--- end payload ---\n");
    }

    // Hooks get first refusal (a paywall or an approval prompt could short
    // circuit here by supplying headers). Null is the ordinary path: nothing
    // intercepted, so go build and sign the payment.
    let paymentHeaders = await httpClient.handlePaymentRequired(paymentRequired);
    if (!paymentHeaders) {
      const payload = await httpClient.createPaymentPayload(paymentRequired);
      paymentHeaders = httpClient.encodePaymentSignatureHeader(payload);
    }
    console.log(`     signed, sending headers: ${Object.keys(paymentHeaders).join(", ")}`);

    const paid = await fetch(url, { headers: paymentHeaders });
    console.log(`  3. paid request -> ${paid.status}`);
    if (!paid.ok) {
      throw new Error(`Paid request failed with ${paid.status}: ${await paid.text()}`);
    }

    const settle = httpClient.getPaymentSettleResponse((name) => paid.headers.get(name));
    const transactionId = settle.transaction;

    console.log("\nSMOKE TEST PASSED");
    console.log(`  body        : ${JSON.stringify(await paid.json())}`);
    console.log(`  transaction : ${transactionId ?? "(not reported)"}`);
    if (transactionId) {
      console.log(`  hashscan    : ${hashscanTx(transactionId)}`);
    }
    console.log("\nThe settlement path works. Proceed with the rest of the build.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  console.error("\nSMOKE TEST FAILED");
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    "\nThis is the walk-away gate. If this cannot be made to pass, stop and report " +
      "rather than building around it.",
  );
  process.exitCode = 1;
});
