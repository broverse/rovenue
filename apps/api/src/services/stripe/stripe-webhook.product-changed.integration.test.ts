// =============================================================
// processStripeEvent — subscription.product_changed on a plan change
// =============================================================
//
// Stripe keeps the SAME subscription id across a plan change, so the
// change is visible only as the purchase row's product moving. This
// pins three things that only a real database can show:
//
//   1. the outbox row is emitted, carrying both sides of the move and a
//      NULL changeType (Stripe states no direction, and deriving one from
//      the charged amount mislabels every prorated upgrade);
//   2. `purchases.productId` converges onto the new product — without
//      that write the before-image would keep pointing at the old
//      product forever;
//   3. so a SECOND delivery of the same plan emits nothing more.
//
// Integration: hits the dev Postgres 16 (docker-compose host port 5433).
// The customer.subscription.updated path reads only event.data.object,
// so no live Stripe API call is made — a dummy client satisfies the
// signature.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import {
  getDb,
  outboxEvents,
  products,
  projects,
  purchases,
  subscribers,
} from "@rovenue/db";
import { processStripeEvent } from "./stripe-webhook";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_spchg_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_spchg_${RUN_ID}`;
const APP_USER_ID = `app_user_spchg_${RUN_ID}`;
const BASIC_PRODUCT_ID = `prod_basic_${RUN_ID}`;
const PRO_PRODUCT_ID = `prod_pro_${RUN_ID}`;
const BASIC_PRICE_ID = `price_basic_${RUN_ID}`;
const PRO_PRICE_ID = `price_pro_${RUN_ID}`;
const STRIPE_SUB_ID = `sub_stripe_spchg_${RUN_ID}`;

const PRODUCT_CHANGED = "subscription.product_changed";
const TERM_SECONDS = 30 * 86_400;

function updatedEvent(eventId: string, priceId: string): Stripe.Event {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    id: eventId,
    type: "customer.subscription.updated",
    created: nowSeconds,
    data: {
      object: {
        id: STRIPE_SUB_ID,
        customer: `cus_spchg_${RUN_ID}`,
        status: "active",
        start_date: nowSeconds - TERM_SECONDS,
        current_period_end: nowSeconds + TERM_SECONDS,
        cancel_at_period_end: false,
        metadata: { app_user_id: APP_USER_ID },
        items: {
          data: [
            {
              price: { id: priceId, unit_amount: 4999, currency: "usd" },
            } as never,
          ],
        },
      } as unknown as Stripe.Subscription,
    },
  } as Stripe.Event;
}

async function productChangedRows() {
  return getDb()
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateId, SUBSCRIBER_ID),
        eq(outboxEvents.eventType, PRODUCT_CHANGED),
      ),
    );
}

describe("processStripeEvent — subscription.product_changed", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `SPChg ${RUN_ID}` });
    await db.insert(subscribers).values({
      id: SUBSCRIBER_ID,
      projectId: PROJECT_ID,
      rovenueId: APP_USER_ID,
      appUserId: APP_USER_ID,
    });
    await db.insert(products).values([
      {
        id: BASIC_PRODUCT_ID,
        projectId: PROJECT_ID,
        identifier: BASIC_PRICE_ID,
        type: "SUBSCRIPTION",
        storeIds: { stripe: BASIC_PRICE_ID },
        displayName: `Basic ${RUN_ID}`,
        accessIds: [],
      },
      {
        id: PRO_PRODUCT_ID,
        projectId: PROJECT_ID,
        identifier: PRO_PRICE_ID,
        type: "SUBSCRIPTION",
        storeIds: { stripe: PRO_PRICE_ID },
        displayName: `Pro ${RUN_ID}`,
        accessIds: [],
      },
    ]);
    // The subscriber is already on Basic; the event below moves them to Pro.
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: SUBSCRIBER_ID,
      productId: BASIC_PRODUCT_ID,
      store: "STRIPE",
      storeTransactionId: STRIPE_SUB_ID,
      originalTransactionId: STRIPE_SUB_ID,
      status: "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: new Date(Date.now() + TERM_SECONDS * 1000),
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: true,
    });
  });

  afterAll(async () => {
    await getDb().delete(outboxEvents).where(eq(outboxEvents.aggregateId, SUBSCRIBER_ID));
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("emits subscription.product_changed when the price maps to a different product", async () => {
    const result = await processStripeEvent({
      projectId: PROJECT_ID,
      event: updatedEvent(`evt_spchg_move_${RUN_ID}`, PRO_PRICE_ID),
      account: {} as never,
    });
    expect(result.status).toBe("processed");

    const rows = await productChangedRows();
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.previousProductId).toBe(BASIC_PRODUCT_ID);
    expect(payload.productId).toBe(PRO_PRODUCT_ID);
    // Stripe states no direction. A null is honest; a guess is not.
    expect(payload.changeType).toBeNull();
    expect(payload.subscriberId).toBe(SUBSCRIBER_ID);
  });

  it("converges the purchase onto the new product so the move is emitted once", async () => {
    const db = getDb();

    const [row] = await db
      .select({ productId: purchases.productId })
      .from(purchases)
      .where(
        and(
          eq(purchases.store, "STRIPE"),
          eq(purchases.storeTransactionId, STRIPE_SUB_ID),
        ),
      );
    expect(row?.productId).toBe(PRO_PRODUCT_ID);

    // A second delivery of the SAME plan is not a second plan change.
    const result = await processStripeEvent({
      projectId: PROJECT_ID,
      event: updatedEvent(`evt_spchg_repeat_${RUN_ID}`, PRO_PRICE_ID),
      account: {} as never,
    });
    expect(result.status).toBe("processed");

    expect(await productChangedRows()).toHaveLength(1);
  });
});
