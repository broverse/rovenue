// =============================================================
// reconcileAppleReceiptSubscriber — receipt/webhook convergence
// =============================================================
//
// Proves the RevenueCat/Adapty model: a webhook that arrives BEFORE the
// receipt creates a synthetic owner keyed by the transaction anchor and
// carrying the appAccountToken. When the receipt then arrives, the
// canonical app-user subscriber must absorb that synthetic (purchases +
// the token binding) instead of forking into a second row — and without
// violating the partial unique index on (projectId, appleAppAccountToken).
//
// Integration: hits the dev Postgres 16 (docker-compose host port 5433).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, products, projects, purchases, subscribers } from "@rovenue/db";
import { reconcileAppleReceiptSubscriber } from "./receipt-verify";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_aat_${RUN_ID}`;
const PRODUCT_ID = `prod_aat_${RUN_ID}`;
const APPLE_PRODUCT_ID = `com.app.pro.${RUN_ID}`;
const TOKEN = "550e8400-e29b-41d4-a716-446655440000";
const DEVICE = `rov_device_${RUN_ID}`;

async function seedProduct() {
  const db = getDb();
  await db.insert(projects).values({ id: PROJECT_ID, name: `AAT ${RUN_ID}` });
  await db.insert(products).values({
    id: PRODUCT_ID,
    projectId: PROJECT_ID,
    identifier: APPLE_PRODUCT_ID,
    type: "SUBSCRIPTION",
    storeIds: { apple: APPLE_PRODUCT_ID },
    displayName: `AAT Product ${RUN_ID}`,
    accessIds: [],
  });
}

afterAll(async () => {
  await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
});

beforeEach(async () => {
  // Fresh project per test so unique indexes never collide across cases.
  await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  await seedProduct();
});

describe("reconcileAppleReceiptSubscriber", () => {
  it("merges a webhook-first synthetic into the canonical app-user subscriber and rebinds the token", async () => {
    const db = getDb();
    const OTXN = `otxn_merge_${RUN_ID}`;

    // Webhook-first: synthetic owner keyed by the transaction anchor,
    // carrying the appAccountToken (as resolveSubscriber would create it).
    const [synthetic] = await db
      .insert(subscribers)
      .values({
        projectId: PROJECT_ID,
        rovenueId: `apple:${OTXN}`,
        appUserId: `apple:${OTXN}`,
        appleAppAccountToken: TOKEN,
      })
      .returning();
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: synthetic!.id,
      productId: PRODUCT_ID,
      store: "APP_STORE",
      storeTransactionId: `txn_${OTXN}`,
      originalTransactionId: OTXN,
      status: "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: true,
      environment: "SANDBOX",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: new Date(Date.now() + 30 * 86_400_000),
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: true,
    });

    const canonical = await reconcileAppleReceiptSubscriber({
      projectId: PROJECT_ID,
      appUserId: DEVICE,
      appAccountToken: TOKEN,
      originalTransactionId: OTXN,
    });

    // Canonical is the app-user row, now bound to the token.
    expect(canonical.rovenueId).toBe(DEVICE);
    expect(canonical.appleAppAccountToken).toBe(TOKEN);

    // The synthetic is soft-deleted as merged into canonical, token released.
    const [syn] = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, synthetic!.id));
    expect(syn!.deletedAt).not.toBeNull();
    expect(syn!.mergedInto).toBe(canonical.id);
    expect(syn!.appleAppAccountToken).toBeNull();

    // The purchase now belongs to the canonical subscriber.
    const [pur] = await db
      .select({ subscriberId: purchases.subscriberId })
      .from(purchases)
      .where(
        and(
          eq(purchases.projectId, PROJECT_ID),
          eq(purchases.originalTransactionId, OTXN),
        ),
      );
    expect(pur!.subscriberId).toBe(canonical.id);
  });

  it("receipt-first: creates the canonical subscriber and binds the token (no merge)", async () => {
    const OTXN = `otxn_first_${RUN_ID}`;
    const canonical = await reconcileAppleReceiptSubscriber({
      projectId: PROJECT_ID,
      appUserId: DEVICE,
      appAccountToken: TOKEN,
      originalTransactionId: OTXN,
    });
    expect(canonical.rovenueId).toBe(DEVICE);
    expect(canonical.appleAppAccountToken).toBe(TOKEN);
  });

  it("is idempotent when the canonical row already holds the token", async () => {
    const OTXN = `otxn_idem_${RUN_ID}`;
    const first = await reconcileAppleReceiptSubscriber({
      projectId: PROJECT_ID,
      appUserId: DEVICE,
      appAccountToken: TOKEN,
      originalTransactionId: OTXN,
    });
    const second = await reconcileAppleReceiptSubscriber({
      projectId: PROJECT_ID,
      appUserId: DEVICE,
      appAccountToken: TOKEN,
      originalTransactionId: OTXN,
    });
    expect(second.id).toBe(first.id);
    expect(second.appleAppAccountToken).toBe(TOKEN);
  });
});
