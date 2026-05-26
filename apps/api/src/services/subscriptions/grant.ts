import { createId } from "@paralleldrive/cuid2";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import type { GrantSubscriptionRequest } from "@rovenue/shared";
import { audit } from "../../lib/audit";

// =============================================================
// grantComp — manually grant a complimentary subscription
// =============================================================

export type GrantParams = {
  projectId: string;
  actorUserId: string;
  input: GrantSubscriptionRequest;
};

/**
 * Grant a complimentary subscription to a subscriber.
 *
 * Opens a single transaction that:
 *  1. Validates subscriber belongs to projectId
 *  2. Validates product belongs to projectId
 *  3. Inserts a MANUAL purchase row
 *  4. Writes subscriber_access rows for every entitlement key on the product
 *  5. Inserts an outbox_events row for downstream analytics
 *  6. Appends an audit_log row (commits atomically with the above)
 */
export async function grantComp(
  params: GrantParams,
): Promise<typeof drizzle.schema.purchases.$inferSelect> {
  const { projectId, actorUserId, input } = params;

  // ------------------------------------------------------------------
  // Step 1 — compute expiresDate BEFORE opening the tx (cheap, pure)
  // ------------------------------------------------------------------
  const now = new Date();
  let expiresDate: Date | null;

  if (input.duration.kind === "preset") {
    const preset = input.duration.preset;
    if (preset === "lifetime") {
      expiresDate = null;
    } else {
      const d = new Date(now);
      if (preset === "1mo") {
        d.setMonth(d.getMonth() + 1);
      } else if (preset === "3mo") {
        d.setMonth(d.getMonth() + 3);
      } else if (preset === "6mo") {
        d.setMonth(d.getMonth() + 6);
      } else {
        // "1yr"
        d.setFullYear(d.getFullYear() + 1);
      }
      expiresDate = d;
    }
  } else {
    // kind === "custom"
    const parsed = new Date(input.duration.expiresAt);
    if (parsed.getTime() <= now.getTime()) {
      throw new HTTPException(400, {
        message: "expiresAt must be a date in the future",
      });
    }
    expiresDate = parsed;
  }

  // ------------------------------------------------------------------
  // Steps 2-6 inside a single transaction
  // ------------------------------------------------------------------
  const { subscribers, products, purchases: purchasesTable } = drizzle.schema;

  return drizzle.db.transaction(async (tx) => {
    // Step 2a — look up subscriber
    const [sub] = await tx
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, input.subscriberId))
      .limit(1);

    if (!sub || sub.projectId !== projectId) {
      throw new HTTPException(404, {
        message: "subscriber not found",
      });
    }

    // Step 2b — look up product
    const [prod] = await tx
      .select()
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);

    if (!prod || prod.projectId !== projectId) {
      throw new HTTPException(404, {
        message: "product not found",
      });
    }

    // Step 2c — insert purchase
    const storeTransactionId = `comp_${createId()}`;
    const [purchase] = await tx
      .insert(purchasesTable)
      .values({
        projectId,
        subscriberId: sub.id,
        productId: prod.id,
        store: "MANUAL",
        storeTransactionId,
        originalTransactionId: storeTransactionId,
        status: "ACTIVE",
        isTrial: false,
        isIntroOffer: false,
        isSandbox: false,
        environment: "PRODUCTION",
        purchaseDate: now,
        originalPurchaseDate: now,
        expiresDate,
        priceAmount: "0",
        priceCurrency: "USD",
        autoRenewStatus: false,
      })
      .returning();

    if (!purchase) {
      throw new Error("grantComp: purchase insert returned no rows");
    }

    // Step 2d — write subscriber_access rows for every entitlement key
    const entitlementKeys = (prod.entitlementKeys ?? []) as string[];
    for (const key of entitlementKeys) {
      await drizzle.accessRepo.createAccess(tx, {
        subscriberId: sub.id,
        purchaseId: purchase.id,
        entitlementKey: key,
        isActive: true,
        expiresDate,
        store: "MANUAL",
      });
    }

    // Step 2e — outbox event (REVENUE_EVENT / INITIAL)
    await drizzle.outboxRepo.insert(tx, {
      aggregateType: "REVENUE_EVENT",
      aggregateId: purchase.id,
      eventType: "revenue.event.recorded",
      payload: {
        purchaseId: purchase.id,
        projectId,
        subscriberId: sub.id,
        productId: prod.id,
        type: "INITIAL",
        store: "MANUAL",
        amount: "0",
        amountUsd: "0",
        currency: "USD",
        eventDate: now.toISOString(),
      },
    });

    // Step 2f — audit log (runs inside tx so it commits atomically)
    await audit(
      {
        projectId,
        userId: actorUserId,
        action: "subscription.granted",
        resource: "purchase",
        resourceId: purchase.id,
        before: null,
        after: {
          store: "MANUAL",
          expiresDate: expiresDate?.toISOString() ?? null,
          productId: prod.id,
        },
        ipAddress: null,
        userAgent: null,
      },
      tx,
    );

    return purchase;
  });
}
