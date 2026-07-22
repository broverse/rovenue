import { Hono } from "hono";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { ProductType, drizzle } from "@rovenue/db";
import { getAllBalances } from "../../services/credit-engine";
import { grantPurchaseCurrencies } from "../../services/purchase-credits";
import { syncAccess } from "../../services/access-engine";
import { recordEvent } from "../../services/experiment-engine";
import {
  verifyReceipt,
  type VerifyReceiptStore,
} from "../../services/receipt-verify";
import { idempotency } from "../../middleware/idempotency";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { buildAccessResponse } from "../../lib/access-response";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";
import { presentedContextSchema } from "../../lib/presented-context";

// =============================================================
// /v1/receipts — receipt verification + entitlement grant
// =============================================================
//
// Split per store so the SDK hits a route that matches its native
// purchase flow: StoreKit 2 → /apple, Play Billing → /google. The
// shared body shape is `{ appUserId, productId, receipt }` — the
// store discriminator is the route itself. Each call fans out to
// Apple/Google receipt verification APIs, so we keep the tighter
// per-endpoint 30/min envelope on top of the /v1 rate limit.

const log = logger.child("route:v1:receipts");

export const receiptBodySchema = z.object({
  receipt: z.string().min(1),
  appUserId: z.string().min(1),
  productId: z.string().min(1),
  // Paywall-attribution snapshot from the placement that served the SDK's
  // purchase flow. Opaque — never validated against live rows here, so a
  // stale/fabricated value can never fail the purchase.
  presentedContext: presentedContextSchema.optional(),
});

export type ReceiptBody = z.infer<typeof receiptBodySchema>;

// 30 req/min per API key on top of the /v1 envelope. Shared across
// /apple + /google so a misbehaving client can't side-step the cap
// by alternating stores.
const receiptsEndpointLimit = endpointRateLimit({
  name: "receipts",
  max: 30,
});

async function handleReceipt(
  store: VerifyReceiptStore,
  projectId: string,
  body: ReceiptBody,
) {
  const { subscriber, product, purchase } = await verifyReceipt({
    projectId,
    store,
    receipt: body.receipt,
    productId: body.productId,
    appUserId: body.appUserId,
    presentedContext: body.presentedContext,
  });

  await syncAccess(subscriber.id);

  if (product.type === ProductType.CONSUMABLE) {
    await grantPurchaseCurrencies({
      subscriberId: subscriber.id,
      productId: product.id,
      purchaseId: purchase.id,
      productIdentifier: product.identifier,
    });
  }

  const [access, rawBalances, currencies] = await Promise.all([
    buildAccessResponse(subscriber.id),
    getAllBalances(subscriber.id),
    drizzle.virtualCurrencyRepo.listVirtualCurrencies(
      drizzle.db,
      subscriber.projectId,
      { includeArchived: true },
    ),
  ]);

  const codeById = new Map(currencies.map((vc) => [vc.id, vc.code]));
  const virtualCurrencyBalances: Record<string, number> = {};
  for (const b of rawBalances) {
    const code = codeById.get(b.currencyId);
    if (code) virtualCurrencyBalances[code] = b.balance;
  }

  // Auto-conversion: tag every active experiment assignment the
  // subscriber is in with a "purchase" event. Any experiment whose
  // metrics list includes "purchase" gets its convertedAt /
  // purchaseId / revenue fields filled in. Failures are isolated
  // from the purchase response — the primary request succeeds even
  // if tracking hiccups.
  try {
    const priceAmount =
      purchase.priceAmount != null ? Number(purchase.priceAmount) : undefined;
    await recordEvent(subscriber.id, "purchase", {
      purchaseId: purchase.id,
      revenue: priceAmount,
    });
  } catch (err) {
    log.warn("experiment conversion tracking failed", {
      subscriberId: subscriber.id,
      purchaseId: purchase.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  log.info("receipt verified", {
    projectId,
    store,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    product: product.identifier,
  });

  return {
    subscriber: {
      id: subscriber.id,
      appUserId: subscriber.appUserId,
      attributes: subscriber.attributes,
    },
    access,
    virtualCurrencyBalances,
  };
}

export const receiptsRoute = new Hono()
  .post(
    "/apple",
    receiptsEndpointLimit,
    idempotency,
    validate("json", receiptBodySchema),
    async (c) => {
      const project = c.get("project");
      const body = c.req.valid("json");
      const data = await handleReceipt("APP_STORE", project.id, body);
      return c.json(ok(data));
    },
  )
  .post(
    "/google",
    receiptsEndpointLimit,
    idempotency,
    validate("json", receiptBodySchema),
    async (c) => {
      const project = c.get("project");
      const body = c.req.valid("json");
      const data = await handleReceipt("PLAY_STORE", project.id, body);
      return c.json(ok(data));
    },
  );

