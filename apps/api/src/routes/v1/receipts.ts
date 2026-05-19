import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ProductType, drizzle } from "@rovenue/db";
import { addCredits } from "../../services/credit-engine";
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
  });

  await syncAccess(subscriber.id);

  if (
    product.type === ProductType.CONSUMABLE &&
    product.creditAmount &&
    product.creditAmount > 0
  ) {
    const alreadyCredited =
      await drizzle.creditLedgerRepo.findExistingPurchaseCredit(
        drizzle.db,
        subscriber.id,
        purchase.id,
      );
    if (!alreadyCredited) {
      await addCredits({
        subscriberId: subscriber.id,
        amount: product.creditAmount,
        referenceType: "purchase",
        referenceId: purchase.id,
        description: `Credits for ${product.identifier}`,
      });
    }
  }

  const [access, balance] = await Promise.all([
    buildAccessResponse(subscriber.id),
    currentBalance(subscriber.id),
  ]);

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
    credits: { balance },
  };
}

export const receiptsRoute = new Hono()
  .post(
    "/apple",
    receiptsEndpointLimit,
    idempotency,
    zValidator("json", receiptBodySchema),
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
    zValidator("json", receiptBodySchema),
    async (c) => {
      const project = c.get("project");
      const body = c.req.valid("json");
      const data = await handleReceipt("PLAY_STORE", project.id, body);
      return c.json(ok(data));
    },
  );

async function currentBalance(subscriberId: string): Promise<number> {
  const last = await drizzle.creditLedgerRepo.findLatestBalance(
    drizzle.db,
    subscriberId,
  );
  return last?.balance ?? 0;
}
