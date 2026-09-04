// =============================================================
// expireSupersededApplePurchases — Apple upgrade supersession
// =============================================================
//
// Apple mints a NEW transactionId for every RENEWAL, and upsertPurchase
// is keyed on it, so a long-lived Apple subscription chain holds ONE
// ROW PER BILLING PERIOD under a single originalTransactionId. The
// supersede must touch exactly the row the upgrade replaced — not the
// renewal history. A naive "expire every sibling sharing the
// originalTransactionId" would rewrite the subscription's entire
// renewal history and emit an audit row + outbox event per period; the
// `expiresDate > now` bound is what keeps past periods (which already
// have past expiries) out of the candidate set.
//
// Integration: hits a real Postgres so the query's narrowness — the
// actual thing under test — is proven against the database, not a mock.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  products,
  projects,
  purchases,
  subscribers,
  type PurchaseStatus,
} from "@rovenue/db";
import { expireSupersededApplePurchases } from "./apple-supersede";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_apple_supersede_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_apple_supersede_${RUN_ID}`;
const PRODUCT_ID = `prod_apple_supersede_${RUN_ID}`;
const APPLE_PRODUCT_ID = `com.app.supersede.${RUN_ID}`;

const NOW = new Date("2026-09-03T00:00:00Z");

let seedSeq = 0;

/**
 * Seeds a purchase row and returns the RUN_ID-suffixed ids actually
 * written, so callers pass those back into
 * `expireSupersededApplePurchases` rather than reconstructing the
 * suffix themselves (which would be a footgun if seeding order ever
 * changes).
 */
async function seedApplePurchase(opts: {
  originalTransactionId: string;
  storeTransactionId: string;
  status: PurchaseStatus;
  expiresDate: Date;
}): Promise<{
  id: string;
  projectId: string;
  subscriberId: string;
  originalTransactionId: string;
  storeTransactionId: string;
}> {
  seedSeq += 1;
  const db = getDb();
  const originalTransactionId = `${opts.originalTransactionId}_${RUN_ID}`;
  const storeTransactionId = `${opts.storeTransactionId}_${RUN_ID}_${seedSeq}`;
  const [row] = await db
    .insert(purchases)
    .values({
      projectId: PROJECT_ID,
      subscriberId: SUBSCRIBER_ID,
      productId: PRODUCT_ID,
      store: "APP_STORE",
      storeTransactionId,
      originalTransactionId,
      status: opts.status,
      isTrial: false,
      isIntroOffer: false,
      isSandbox: true,
      environment: "SANDBOX",
      purchaseDate: new Date("2026-08-01T00:00:00Z"),
      originalPurchaseDate: new Date("2026-01-01T00:00:00Z"),
      expiresDate: opts.expiresDate,
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: true,
    })
    .returning({ id: purchases.id });
  return {
    id: row!.id,
    projectId: PROJECT_ID,
    subscriberId: SUBSCRIBER_ID,
    originalTransactionId,
    storeTransactionId,
  };
}

async function statusOf(purchaseId: string): Promise<string | undefined> {
  const db = getDb();
  const [row] = await db
    .select({ status: purchases.status })
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  return row?.status;
}

describe("expireSupersededApplePurchases", () => {
  beforeAll(async () => {
    const db = getDb();
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, name: `Apple Supersede ${RUN_ID}` });
    await db.insert(subscribers).values({
      id: SUBSCRIBER_ID,
      projectId: PROJECT_ID,
      rovenueId: `app_user_supersede_${RUN_ID}`,
      appUserId: `app_user_supersede_${RUN_ID}`,
    });
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: APPLE_PRODUCT_ID,
      type: "SUBSCRIPTION",
      storeIds: { apple: APPLE_PRODUCT_ID },
      displayName: `Apple Supersede Product ${RUN_ID}`,
      accessIds: [],
    });
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("expires only the unexpired sibling, never past renewal periods", async () => {
    const original = "1000000000000001";

    const oldPeriods = await Promise.all([
      seedApplePurchase({
        originalTransactionId: original,
        storeTransactionId: "tx_2026_06",
        status: "ACTIVE",
        expiresDate: new Date("2026-07-01T00:00:00Z"),
      }),
      seedApplePurchase({
        originalTransactionId: original,
        storeTransactionId: "tx_2026_07",
        status: "ACTIVE",
        expiresDate: new Date("2026-08-01T00:00:00Z"),
      }),
    ]);
    const superseded = await seedApplePurchase({
      originalTransactionId: original,
      storeTransactionId: "tx_2026_08",
      status: "ACTIVE",
      expiresDate: new Date("2026-10-01T00:00:00Z"),
    });
    const upgraded = await seedApplePurchase({
      originalTransactionId: original,
      storeTransactionId: "tx_upgrade",
      status: "ACTIVE",
      expiresDate: new Date("2026-10-01T00:00:00Z"),
    });

    const result = await expireSupersededApplePurchases({
      projectId: superseded.projectId,
      originalTransactionId: superseded.originalTransactionId,
      currentStoreTransactionId: upgraded.storeTransactionId,
      now: NOW,
      source: "test",
    });

    expect(result.expired).toBe(1);
    await expect(statusOf(superseded.id)).resolves.toBe("EXPIRED");
    await expect(statusOf(upgraded.id)).resolves.toBe("ACTIVE");
    for (const period of oldPeriods) {
      await expect(statusOf(period.id)).resolves.toBe("ACTIVE");
    }
  });

  it("leaves a terminal sibling terminal", async () => {
    const original = "1000000000000002";
    const refunded = await seedApplePurchase({
      originalTransactionId: original,
      storeTransactionId: "tx_refunded",
      status: "REFUNDED",
      expiresDate: new Date("2026-10-01T00:00:00Z"),
    });

    const result = await expireSupersededApplePurchases({
      projectId: refunded.projectId,
      originalTransactionId: refunded.originalTransactionId,
      currentStoreTransactionId: `tx_upgrade_never_seeded_${RUN_ID}`,
      now: NOW,
      source: "test",
    });

    expect(result.expired).toBe(0);
    await expect(statusOf(refunded.id)).resolves.toBe("REFUNDED");
  });
});
