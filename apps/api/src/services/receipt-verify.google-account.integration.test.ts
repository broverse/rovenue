// =============================================================
// reconcileGoogleReceiptSubscriber — receipt/webhook convergence
// =============================================================
//
// Google analog of the Apple appAccountToken convergence. A Play RTDN
// that arrives BEFORE the receipt creates a synthetic owner keyed by the
// purchaseToken anchor. When the receipt then arrives, the canonical
// app-user subscriber must absorb that synthetic (purchases) instead of
// forking into a second row. Google's purchaseToken (= the receipt) is
// the store-authoritative anchor present in BOTH paths, so no dedicated
// obfuscated-account-id column is needed.
//
// Integration: hits the dev Postgres 16 (docker-compose host port 5433).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, products, projects, purchases, subscribers } from "@rovenue/db";
import { reconcileGoogleReceiptSubscriber } from "./receipt-verify";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_gacct_${RUN_ID}`;
const PRODUCT_ID = `prod_gacct_${RUN_ID}`;
const GOOGLE_PRODUCT_ID = `com.app.pro.${RUN_ID}`;
const DEVICE = `rov_device_${RUN_ID}`;

async function seedProduct() {
  const db = getDb();
  await db.insert(projects).values({ id: PROJECT_ID, name: `GAcct ${RUN_ID}` });
  await db.insert(products).values({
    id: PRODUCT_ID,
    projectId: PROJECT_ID,
    identifier: GOOGLE_PRODUCT_ID,
    type: "SUBSCRIPTION",
    storeIds: { google: GOOGLE_PRODUCT_ID },
    displayName: `GAcct Product ${RUN_ID}`,
    accessIds: [],
  });
}

afterAll(async () => {
  await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
});

beforeEach(async () => {
  await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  await seedProduct();
});

describe("reconcileGoogleReceiptSubscriber", () => {
  it("merges a webhook-first synthetic into the canonical app-user subscriber", async () => {
    const db = getDb();
    const TOKEN = `tok_merge_${RUN_ID}`;

    // RTDN-first: synthetic owner keyed by the purchaseToken anchor, holding
    // the purchase (storeTransactionId = purchaseToken).
    const [synthetic] = await db
      .insert(subscribers)
      .values({
        projectId: PROJECT_ID,
        rovenueId: `google:${TOKEN.slice(0, 24)}`,
        appUserId: `google:${TOKEN.slice(0, 24)}`,
      })
      .returning();
    await db.insert(purchases).values({
      projectId: PROJECT_ID,
      subscriberId: synthetic!.id,
      productId: PRODUCT_ID,
      store: "PLAY_STORE",
      storeTransactionId: TOKEN,
      originalTransactionId: TOKEN,
      status: "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: new Date(Date.now() + 30 * 86_400_000),
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: true,
    });

    const canonical = await reconcileGoogleReceiptSubscriber({
      projectId: PROJECT_ID,
      appUserId: DEVICE,
      purchaseToken: TOKEN,
    });

    expect(canonical.rovenueId).toBe(DEVICE);

    const [syn] = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, synthetic!.id));
    expect(syn!.deletedAt).not.toBeNull();
    expect(syn!.mergedInto).toBe(canonical.id);

    const [pur] = await db
      .select({ subscriberId: purchases.subscriberId })
      .from(purchases)
      .where(
        and(
          eq(purchases.projectId, PROJECT_ID),
          eq(purchases.storeTransactionId, TOKEN),
        ),
      );
    expect(pur!.subscriberId).toBe(canonical.id);
  });

  it("receipt-first: creates the canonical subscriber (no merge)", async () => {
    const TOKEN = `tok_first_${RUN_ID}`;
    const canonical = await reconcileGoogleReceiptSubscriber({
      projectId: PROJECT_ID,
      appUserId: DEVICE,
      purchaseToken: TOKEN,
    });
    expect(canonical.rovenueId).toBe(DEVICE);
  });
});
