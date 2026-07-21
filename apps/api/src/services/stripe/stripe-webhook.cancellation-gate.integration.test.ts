// =============================================================
// processStripeEvent — CANCELLATION emit is gated on the EXPIRED
// write actually applying (FINDING 2)
// =============================================================
//
// applySubscriptionDeleted writes EXPIRED through the transition guard
// and then emits a $0 CANCELLATION revenue event. On an already
// terminal (REFUNDED/REVOKED) row the EXPIRED write is withheld, so
// the CANCELLATION emit MUST be skipped — otherwise a refunded
// subscription gets a spurious churn/lifecycle event.
//
// Integration: hits the dev Postgres 16 (docker-compose host port
// 5433). The customer.subscription.deleted path reads only
// event.data.object, so no live Stripe API call is made — a dummy
// client satisfies the signature.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import {
  getDb,
  products,
  projects,
  purchases,
  revenueEvents,
  subscribers,
} from "@rovenue/db";
import { processStripeEvent } from "./stripe-webhook";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_scancel_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_scancel_${RUN_ID}`;
const PRODUCT_ID = `prod_scancel_${RUN_ID}`;
const STRIPE_SUB_ID = `sub_stripe_${RUN_ID}`;
const STRIPE_PRICE_ID = `price_${RUN_ID}`;

function makeDeletedEvent(): Stripe.Event {
  return {
    id: `evt_scancel_${RUN_ID}`,
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: STRIPE_SUB_ID,
        status: "canceled",
        canceled_at: Math.floor(Date.now() / 1000),
        items: { data: [{ price: { id: STRIPE_PRICE_ID } } as never] },
      } as unknown as Stripe.Subscription,
    },
  } as Stripe.Event;
}

describe("processStripeEvent — CANCELLATION gate on terminal row", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `SCancel ${RUN_ID}` });
    await db.insert(subscribers).values({
      id: SUBSCRIBER_ID,
      projectId: PROJECT_ID,
      rovenueId: `app_user_${RUN_ID}`,
      appUserId: `app_user_${RUN_ID}`,
    });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: STRIPE_PRICE_ID,
      type: "SUBSCRIPTION",
      storeIds: { stripe: STRIPE_PRICE_ID },
      displayName: `SCancel Product ${RUN_ID}`,
      accessIds: [],
    });
    // Seed an ALREADY-REFUNDED purchase for this Stripe subscription:
    // a later subscription.deleted must NOT resurrect it and must NOT
    // emit a CANCELLATION lifecycle event.
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      store: "STRIPE",
      storeTransactionId: STRIPE_SUB_ID,
      originalTransactionId: STRIPE_SUB_ID,
      status: "REFUNDED",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: false,
    });
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("does not emit a CANCELLATION event when deleting an already-REFUNDED subscription", async () => {
    const db = getDb();

    const result = await processStripeEvent({
      projectId: PROJECT_ID,
      event: makeDeletedEvent(),
      stripe: {} as unknown as Stripe,
      accountId: "acct_test",
    });
    expect(result.status).toBe("processed");

    // Row stays REFUNDED — the EXPIRED write was withheld.
    const [row] = await db
      .select({ status: purchases.status })
      .from(purchases)
      .where(
        and(
          eq(purchases.store, "STRIPE"),
          eq(purchases.storeTransactionId, STRIPE_SUB_ID),
        ),
      );
    expect(row?.status).toBe("REFUNDED");

    // No CANCELLATION revenue event was emitted for the refunded row.
    const cancellations = await db
      .select({ id: revenueEvents.id })
      .from(revenueEvents)
      .where(
        and(
          eq(revenueEvents.projectId, PROJECT_ID),
          eq(revenueEvents.type, "CANCELLATION"),
        ),
      );
    expect(cancellations.length).toBe(0);
  });
});
