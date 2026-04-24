// =============================================================
// revenue-events repo — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
//
// Setup mirrors apps/api/tests/setup.ts: env fallbacks target the
// docker-compose service so tests run without extra configuration.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql, and } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import { createRevenueEvent } from "./revenue-events";

// ---------------------------------------------------------------------------
// Env bootstrap (mirrors apps/api/tests/setup.ts approach)
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

// ---------------------------------------------------------------------------
// DB connection owned by this test file
// ---------------------------------------------------------------------------

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
    .values({ name: "Test Project", slug: `test-proj-${Date.now()}` })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project;
}

async function seedSubscriber(projectId: string) {
  const [subscriber] = await db
    .insert(schema.subscribers)
    .values({ projectId, appUserId: `user-${Date.now()}` })
    .returning();
  if (!subscriber) throw new Error("seedSubscriber: no row returned");
  return subscriber;
}

async function seedProduct(projectId: string) {
  const [product] = await db
    .insert(schema.products)
    .values({
      projectId,
      identifier: `prod-${Date.now()}`,
      type: "SUBSCRIPTION",
      storeIds: { apple: "com.test.pro" },
      displayName: "Pro",
    })
    .returning();
  if (!product) throw new Error("seedProduct: no row returned");
  return product;
}

async function seedPurchase(
  projectId: string,
  subscriberId: string,
  productId: string,
) {
  const [purchase] = await db
    .insert(schema.purchases)
    .values({
      projectId,
      subscriberId,
      productId,
      store: "APP_STORE",
      storeTransactionId: `txn-${Date.now()}`,
      originalTransactionId: `orig-${Date.now()}`,
      status: "ACTIVE",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      environment: "PRODUCTION",
    })
    .returning();
  if (!purchase) throw new Error("seedPurchase: no row returned");
  return purchase;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRevenueEvent", () => {
  it("writes exactly one outbox row per revenue row", async () => {
    const project = await seedProject();
    const subscriber = await seedSubscriber(project.id);
    const product = await seedProduct(project.id);
    const purchase = await seedPurchase(
      project.id,
      subscriber.id,
      product.id,
    );

    const inserted = await createRevenueEvent(db, {
      projectId: project.id,
      subscriberId: subscriber.id,
      purchaseId: purchase.id,
      productId: product.id,
      type: "INITIAL",
      amount: "9.9900",
      currency: "USD",
      amountUsd: "9.9900",
      store: "APP_STORE",
      eventDate: new Date("2026-04-24T00:00:00Z"),
    });

    // 1. Revenue row exists and ID matches the return value.
    const revenueRows = await db
      .select()
      .from(schema.revenueEvents)
      .where(eq(schema.revenueEvents.id, inserted.id));
    expect(revenueRows).toHaveLength(1);

    // 2. Exactly one REVENUE_EVENT outbox row with matching aggregateId.
    const outboxRows = await db
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateType, "REVENUE_EVENT"),
          eq(schema.outboxEvents.aggregateId, inserted.id),
        ),
      );
    expect(outboxRows).toHaveLength(1);

    // 3. Payload shape matches what the CH MV extractor expects.
    const payload = outboxRows[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      revenueEventId: inserted.id,
      projectId: project.id,
      subscriberId: subscriber.id,
      purchaseId: purchase.id,
      productId: product.id,
      type: "INITIAL",
      store: "APP_STORE",
      amount: "9.9900",
      amountUsd: "9.9900",
      currency: "USD",
      eventDate: "2026-04-24T00:00:00.000Z",
    });
    expect(outboxRows[0]!.eventType).toBe("revenue.event.recorded");
  });

  it("rolls back the outbox row if the revenue row fails (FK violation)", async () => {
    const project = await seedProject();
    const subscriber = await seedSubscriber(project.id);
    const product = await seedProduct(project.id);

    const nonExistentPurchaseId = "nonexistent-purchase-id-that-does-not-exist";

    // Snapshot counts BEFORE the failing call.
    const revenueCountBefore = await db
      .select({ count: sql<string>`count(*)` })
      .from(schema.revenueEvents);
    const outboxCountBefore = await db
      .select({ count: sql<string>`count(*)` })
      .from(schema.outboxEvents);

    await expect(
      createRevenueEvent(db, {
        projectId: project.id,
        subscriberId: subscriber.id,
        purchaseId: nonExistentPurchaseId,
        productId: product.id,
        type: "INITIAL",
        amount: "9.9900",
        currency: "USD",
        amountUsd: "9.9900",
        store: "APP_STORE",
        eventDate: new Date("2026-04-24T00:00:00Z"),
      }),
    ).rejects.toThrow();

    // Neither revenue_events nor outbox_events should have grown.
    const revenueCountAfter = await db
      .select({ count: sql<string>`count(*)` })
      .from(schema.revenueEvents);
    const outboxCountAfter = await db
      .select({ count: sql<string>`count(*)` })
      .from(schema.outboxEvents);

    expect(revenueCountAfter[0]!.count).toBe(revenueCountBefore[0]!.count);
    expect(outboxCountAfter[0]!.count).toBe(outboxCountBefore[0]!.count);
  });
});
