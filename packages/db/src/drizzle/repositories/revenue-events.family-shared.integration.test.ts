// =============================================================
// revenue-events repo — Family Sharing suppression (real Postgres)
// =============================================================
//
// A family member's Apple transaction carries inAppOwnershipType
// FAMILY_SHARED. They genuinely have entitlement — the purchaser paid —
// so recording a second full-price revenue event double-counts MRR and
// LTV. Suppression lives HERE (inside createRevenueEvent), rather than
// at the thirteen call sites, so a future Apple code path cannot forget
// it.
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance.
// Setup mirrors revenue-events.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import { createRevenueEvent } from "./revenue-events";

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

let pool: Pool;
let db: ReturnType<typeof drizzleClient<typeof schema>>;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzleClient(pool, { schema });
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function seedProject() {
  const [project] = await db
    .insert(schema.projects)
    .values({ name: "Test Project — family sharing" })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project;
}

async function seedSubscriber(projectId: string) {
  const [subscriber] = await db
    .insert(schema.subscribers)
    .values({
      projectId,
      rovenueId: `user-${Date.now()}-${Math.random()}`,
      appUserId: `user-${Date.now()}-${Math.random()}`,
    })
    .returning();
  if (!subscriber) throw new Error("seedSubscriber: no row returned");
  return subscriber;
}

async function seedProduct(projectId: string) {
  const [product] = await db
    .insert(schema.products)
    .values({
      projectId,
      identifier: `prod-${Date.now()}-${Math.random()}`,
      type: "SUBSCRIPTION",
      storeIds: { apple: "com.test.pro" },
      displayName: "Pro",
    })
    .returning();
  if (!product) throw new Error("seedProduct: no row returned");
  return product;
}

/**
 * Seed a full project/subscriber/product/purchase fixture with a given
 * `ownershipType` on the purchase row — the exact field
 * `createRevenueEvent` now reads to decide whether to suppress.
 */
async function seedPurchase(opts: { ownershipType: string | null }) {
  const project = await seedProject();
  const subscriber = await seedSubscriber(project.id);
  const product = await seedProduct(project.id);
  const [purchase] = await db
    .insert(schema.purchases)
    .values({
      projectId: project.id,
      subscriberId: subscriber.id,
      productId: product.id,
      store: "APP_STORE",
      storeTransactionId: `txn-${Date.now()}-${Math.random()}`,
      originalTransactionId: `orig-${Date.now()}-${Math.random()}`,
      status: "ACTIVE",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      environment: "PRODUCTION",
      ownershipType: opts.ownershipType,
    })
    .returning();
  if (!purchase) throw new Error("seedPurchase: no row returned");
  return {
    projectId: project.id,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    productId: product.id,
  };
}

async function countRevenueEvents(purchaseId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)` })
    .from(schema.revenueEvents)
    .where(eq(schema.revenueEvents.purchaseId, purchaseId));
  return Number(rows[0]?.count ?? 0);
}

async function countOutboxRows(purchaseId: string): Promise<number> {
  // The co-located REVENUE_EVENT outbox row carries the revenue event's
  // own id as aggregateId, not the purchase id, so a suppressed call
  // (which never creates a revenue_events row) is verified by asserting
  // there is no REVENUE_EVENT outbox row whose payload references this
  // purchase at all.
  const rows = await db
    .select({ count: sql<string>`count(*)` })
    .from(schema.outboxEvents)
    .where(
      and(
        eq(schema.outboxEvents.aggregateType, "REVENUE_EVENT"),
        sql`${schema.outboxEvents.payload}->>'purchaseId' = ${purchaseId}`,
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRevenueEvent — Family Sharing suppression", () => {
  it("writes no revenue row and no outbox row for a family-shared purchase", async () => {
    const { projectId, subscriberId, purchaseId, productId } =
      await seedPurchase({ ownershipType: "FAMILY_SHARED" });

    const result = await createRevenueEvent(db, {
      projectId,
      subscriberId,
      purchaseId,
      productId,
      type: "RENEWAL",
      amount: "9.99",
      currency: "USD",
      amountUsd: "9.99",
      store: "APP_STORE",
      eventDate: new Date(),
    });

    expect(result).toBeNull();
    await expect(countRevenueEvents(purchaseId)).resolves.toBe(0);
    await expect(countOutboxRows(purchaseId)).resolves.toBe(0);
  });

  it("still writes for a purchased (non-shared) purchase", async () => {
    const { projectId, subscriberId, purchaseId, productId } =
      await seedPurchase({ ownershipType: "PURCHASED" });

    const result = await createRevenueEvent(db, {
      projectId,
      subscriberId,
      purchaseId,
      productId,
      type: "RENEWAL",
      amount: "9.99",
      currency: "USD",
      amountUsd: "9.99",
      store: "APP_STORE",
      eventDate: new Date(),
    });

    expect(result).not.toBeNull();
    await expect(countRevenueEvents(purchaseId)).resolves.toBe(1);
    await expect(countOutboxRows(purchaseId)).resolves.toBe(1);
  });

  it("still writes when ownershipType is null (non-Apple stores)", async () => {
    // A too-aggressive suppression (e.g. `ownershipType !== "PURCHASED"`
    // instead of `=== "FAMILY_SHARED"`) would wrongly swallow every
    // Stripe/Google purchase, since only Apple ever populates this
    // column. This case exists specifically to catch that.
    const { projectId, subscriberId, purchaseId, productId } =
      await seedPurchase({ ownershipType: null });

    const result = await createRevenueEvent(db, {
      projectId,
      subscriberId,
      purchaseId,
      productId,
      type: "RENEWAL",
      amount: "9.99",
      currency: "USD",
      amountUsd: "9.99",
      store: "STRIPE",
      eventDate: new Date(),
    });

    expect(result).not.toBeNull();
    await expect(countRevenueEvents(purchaseId)).resolves.toBe(1);
    await expect(countOutboxRows(purchaseId)).resolves.toBe(1);
  });
});
