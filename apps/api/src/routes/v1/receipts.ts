import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import prisma, { ProductType, drizzle, type Prisma } from "@rovenue/db";
import { addCredits } from "../../services/credit-engine";
import { getActiveAccess, syncAccess } from "../../services/access-engine";
import { recordEvent } from "../../services/experiment-engine";
import { verifyReceipt } from "../../services/receipt-verify";
import { idempotency } from "../../middleware/idempotency";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

// =============================================================
// POST /v1/receipts — receipt verification + entitlement grant
// =============================================================
//
// Verify a store receipt, upsert the purchase, reconcile
// entitlement access, credit consumables, and return the
// subscriber's current access map plus credit balance. The
// endpoint is a heavy one: each call fans out to Apple/Google
// receipt verification APIs, so we pair the standard per-project
// rate limit with a tighter per-endpoint 30/min envelope.

const log = logger.child("route:v1:receipts");

export const receiptBodySchema = z.object({
  store: z.enum(["APP_STORE", "PLAY_STORE"]),
  receipt: z.string().min(1),
  appUserId: z.string().min(1),
  productId: z.string().min(1),
});

export type ReceiptBody = z.infer<typeof receiptBodySchema>;

// 30 req/min per API key on top of the /v1 envelope.
const receiptsEndpointLimit = endpointRateLimit({
  name: "receipts",
  max: 30,
});

export const receiptsRoute = new Hono().post(
  "/",
  receiptsEndpointLimit,
  idempotency,
  zValidator("json", receiptBodySchema),
  async (c) => {
    const project = c.get("project");
    const body = c.req.valid("json");

  const { subscriber, product, purchase } = await verifyReceipt({
    projectId: project.id,
    store: body.store,
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
    projectId: project.id,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    product: product.identifier,
  });

    return c.json(
      ok({
        subscriber: {
          id: subscriber.id,
          appUserId: subscriber.appUserId,
          attributes: subscriber.attributes as Prisma.JsonValue,
        },
        access,
        credits: { balance },
      }),
    );
  },
);

export interface AccessResponseEntry {
  isActive: boolean;
  expiresDate: string | null;
  store: string;
  productIdentifier: string;
}

async function buildAccessResponse(
  subscriberId: string,
): Promise<Record<string, AccessResponseEntry>> {
  const raw = await getActiveAccess(subscriberId);
  const purchaseIds = Array.from(
    new Set(Object.values(raw).map((entry) => entry.purchaseId)),
  );

  const purchases = await drizzle.purchaseRepo.findPurchasesByIds(
    drizzle.db,
    purchaseIds,
  );
  const productByPurchase = new Map(
    purchases.map((p) => [p.id, p.product.identifier] as const),
  );

  const result: Record<string, AccessResponseEntry> = {};
  for (const [key, entry] of Object.entries(raw)) {
    result[key] = {
      isActive: entry.isActive,
      expiresDate: entry.expiresDate ? entry.expiresDate.toISOString() : null,
      store: entry.store,
      productIdentifier:
        productByPurchase.get(entry.purchaseId) ?? "unknown",
    };
  }
  return result;
}

async function currentBalance(subscriberId: string): Promise<number> {
  const last = await drizzle.creditLedgerRepo.findLatestBalance(
    drizzle.db,
    subscriberId,
  );
  return last?.balance ?? 0;
}
