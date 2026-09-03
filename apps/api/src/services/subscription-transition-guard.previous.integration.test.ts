// =============================================================
// guardStatusWrite — before-image (`previous`)
// =============================================================
//
// The FOR UPDATE read guardStatusWrite already takes is widened to
// also carry productId and autoRenewStatus (Task 6). This is a real
// Postgres integration test (not the mocked `.stale.test.ts` neighbour)
// because the whole point is to prove the *actual* locked read returns
// these fields — a mock of `lockPurchaseStatusByStoreTransaction` would
// only prove the mock, not the query.
//
// Integration: hits the dev Postgres 16 (docker-compose host port
// 5433). We seed project / subscriber / product / purchase inline.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  PurchaseStatus,
  Store,
  drizzle,
  getDb,
  products,
  projects,
  purchases,
  subscribers,
} from "@rovenue/db";
import { guardStatusWrite } from "./subscription-transition-guard";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_prev_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_prev_${RUN_ID}`;
const PRODUCT_ID = `prod_prev_${RUN_ID}`;
const APPLE_PRODUCT_ID = `com.app.prev.${RUN_ID}`;
const TXN_ID = `txn_prev_${RUN_ID}`;
const OTXN_ID = `otxn_prev_${RUN_ID}`;

async function seedActivePurchase(opts: { autoRenewStatus: boolean | null }) {
  const db = getDb();
  await db
    .insert(projects)
    .values({ id: PROJECT_ID, name: `Previous ${RUN_ID}` });
  await db.insert(subscribers).values({
    id: SUBSCRIBER_ID,
    projectId: PROJECT_ID,
    rovenueId: `app_user_prev_${RUN_ID}`,
    appUserId: `app_user_prev_${RUN_ID}`,
  });
  await db.insert(products).values({
    id: PRODUCT_ID,
    projectId: PROJECT_ID,
    identifier: APPLE_PRODUCT_ID,
    type: "SUBSCRIPTION",
    storeIds: { apple: APPLE_PRODUCT_ID },
    displayName: `Previous Product ${RUN_ID}`,
    accessIds: [],
  });
  await db.insert(purchases).values({
    projectId: PROJECT_ID,
    subscriberId: SUBSCRIBER_ID,
    productId: PRODUCT_ID,
    store: Store.APP_STORE,
    storeTransactionId: TXN_ID,
    originalTransactionId: OTXN_ID,
    status: PurchaseStatus.ACTIVE,
    isTrial: false,
    isIntroOffer: false,
    isSandbox: true,
    environment: "SANDBOX",
    purchaseDate: new Date(),
    originalPurchaseDate: new Date(),
    expiresDate: new Date(Date.now() + 30 * 86_400_000),
    priceAmount: "9.99",
    priceCurrency: "USD",
    autoRenewStatus: opts.autoRenewStatus,
  });

  return {
    projectId: PROJECT_ID,
    productId: PRODUCT_ID,
    storeTransactionId: TXN_ID,
  };
}

describe("guardStatusWrite — before-image", () => {
  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("returns the row's product and auto-renew state as a before-image", async () => {
    const { projectId, productId, storeTransactionId } =
      await seedActivePurchase({ autoRenewStatus: true });

    const result = await guardStatusWrite({
      db: drizzle.db,
      projectId,
      store: Store.APP_STORE,
      storeTransactionId,
      to: PurchaseStatus.ACTIVE,
      source: "test",
    });

    expect(result.previous).toEqual({
      status: PurchaseStatus.ACTIVE,
      productId,
      autoRenewStatus: true,
    });
  });

  it("returns a null before-image for a row that does not exist yet", async () => {
    const result = await guardStatusWrite({
      db: drizzle.db,
      projectId: "p_missing",
      store: Store.APP_STORE,
      storeTransactionId: `tx_missing_${RUN_ID}`,
      to: PurchaseStatus.ACTIVE,
      source: "test",
    });
    expect(result.previous).toBeNull();
  });
});
