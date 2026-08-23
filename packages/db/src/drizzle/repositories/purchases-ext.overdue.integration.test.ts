// =============================================================
// purchases-ext repo — overdue-purchase sweep integration tests
// =============================================================
//
// The expiry sweeper must find EVERY access-granting purchase whose
// expiresDate has passed — not just those that expired inside a recent
// window. A purchase that misses one sweep (worker downtime, a
// per-candidate error) must still be picked up by the next run.
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../client";
import { products, projects, purchases, subscribers } from "../schema";
import { PurchaseStatus, ProductType, Store } from "../../index";
import * as purchaseExtRepo from "./purchases-ext";

const RUN_ID = Date.now();
const P = `prj_overdue_${RUN_ID}`;
const SUB = `sub_overdue_${RUN_ID}`;
const PROD = `prod_overdue_${RUN_ID}`;

const NOW = new Date("2026-08-23T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// The statuses the sweeper acts on — everything non-terminal that can
// still lapse. Mirrors EXPIRY_SWEEP_STATUSES in the api expiry-checker.
const SWEEP_STATUSES: PurchaseStatus[] = [
  PurchaseStatus.ACTIVE,
  PurchaseStatus.GRACE_PERIOD,
  PurchaseStatus.TRIAL,
  PurchaseStatus.PAUSED,
];

let seq = 0;
async function insertPurchase(over: {
  id: string;
  status: PurchaseStatus;
  expiresDate: Date | null;
}): Promise<void> {
  seq += 1;
  const db = getDb();
  await db.insert(purchases).values({
    id: over.id,
    projectId: P,
    subscriberId: SUB,
    productId: PROD,
    store: Store.APP_STORE,
    storeTransactionId: `stx_${RUN_ID}_${seq}`,
    originalTransactionId: `otx_${RUN_ID}_${seq}`,
    status: over.status,
    purchaseDate: new Date(NOW.getTime() - 30 * DAY_MS),
    originalPurchaseDate: new Date(NOW.getTime() - 30 * DAY_MS),
    expiresDate: over.expiresDate,
    environment: "PRODUCTION",
  });
}

describe("findOverduePurchases", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: P, name: "overdue-sweep-test" });
    await db.insert(subscribers).values({
      id: SUB,
      projectId: P,
      rovenueId: `rov_${RUN_ID}`,
    });
    await db.insert(products).values({
      id: PROD,
      projectId: P,
      identifier: `com.test.overdue.${RUN_ID}`,
      type: ProductType.SUBSCRIPTION,
      storeIds: { apple: `com.test.overdue.${RUN_ID}` },
      displayName: "Overdue Sweep Test",
    });
  });

  afterAll(async () => {
    const db = getDb();
    // Purchases + products + subscribers all cascade from the project.
    await db.delete(projects).where(sql`"id" = ${P}`);
  });

  it("returns an ACTIVE purchase whose expiresDate is 3 days past (no lookback blind spot)", async () => {
    const db = getDb();
    await insertPurchase({
      id: `pur_3d_${RUN_ID}`,
      status: PurchaseStatus.ACTIVE,
      expiresDate: new Date(NOW.getTime() - 3 * DAY_MS),
    });

    const rows = await purchaseExtRepo.findOverduePurchases(db, {
      now: NOW,
      statuses: SWEEP_STATUSES,
      limit: 100,
    });

    expect(rows.map((r) => r.id)).toContain(`pur_3d_${RUN_ID}`);
  });

  it("does not return purchases already in a terminal status", async () => {
    const db = getDb();
    await insertPurchase({
      id: `pur_term_${RUN_ID}`,
      status: PurchaseStatus.EXPIRED,
      expiresDate: new Date(NOW.getTime() - 5 * DAY_MS),
    });

    const rows = await purchaseExtRepo.findOverduePurchases(db, {
      now: NOW,
      statuses: SWEEP_STATUSES,
      limit: 100,
    });

    expect(rows.map((r) => r.id)).not.toContain(`pur_term_${RUN_ID}`);
  });

  it("does not return purchases that have not yet expired (or have no expiry)", async () => {
    const db = getDb();
    await insertPurchase({
      id: `pur_future_${RUN_ID}`,
      status: PurchaseStatus.ACTIVE,
      expiresDate: new Date(NOW.getTime() + DAY_MS),
    });
    await insertPurchase({
      id: `pur_lifetime_${RUN_ID}`,
      status: PurchaseStatus.ACTIVE,
      expiresDate: null,
    });

    const rows = await purchaseExtRepo.findOverduePurchases(db, {
      now: NOW,
      statuses: SWEEP_STATUSES,
      limit: 100,
    });

    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(`pur_future_${RUN_ID}`);
    expect(ids).not.toContain(`pur_lifetime_${RUN_ID}`);
  });

  it("caps the batch at `limit`, oldest expiries first, so a backlog drains across runs", async () => {
    const db = getDb();
    await insertPurchase({
      id: `pur_oldest_${RUN_ID}`,
      status: PurchaseStatus.TRIAL,
      expiresDate: new Date(NOW.getTime() - 10 * DAY_MS),
    });

    // The scan is global (the dev database may hold other projects'
    // overdue rows, e.g. seed data), so assert limit on the raw result
    // and ordering on the slice belonging to this test run.
    const capped = await purchaseExtRepo.findOverduePurchases(db, {
      now: NOW,
      statuses: SWEEP_STATUSES,
      limit: 1,
    });
    expect(capped).toHaveLength(1);

    const all = await purchaseExtRepo.findOverduePurchases(db, {
      now: NOW,
      statuses: SWEEP_STATUSES,
      limit: 10_000,
    });
    const mine = all.filter((r) => r.projectId === P).map((r) => r.id);
    // Oldest expiry (10 days) drains before the newer one (3 days).
    expect(mine).toEqual([`pur_oldest_${RUN_ID}`, `pur_3d_${RUN_ID}`]);
  });
});
