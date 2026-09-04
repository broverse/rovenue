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
import {
  createRevenueEvent,
  findRevenueEventById,
  revenueDedupeKind,
} from "./revenue-events";
import { revenueEventType } from "../enums";

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
    .values({ name: "Test Project" })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project;
}

async function seedSubscriber(projectId: string) {
  const [subscriber] = await db
    .insert(schema.subscribers)
    .values({ projectId, rovenueId: `user-${Date.now()}`, appUserId: `user-${Date.now()}` })
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

describe("revenueDedupeKind", () => {
  it("files a non-renewing purchase under the shared purchase key", () => {
    // Convergence matters: if a store webhook ever writes INITIAL for the
    // same transaction a receipt typed NON_RENEWING_PURCHASE, the two must
    // claim ONE dedupe key or the charge is counted twice.
    expect(revenueDedupeKind("NON_RENEWING_PURCHASE")).toBe("purchase");
    expect(revenueDedupeKind("INITIAL")).toBe("purchase");
    expect(revenueDedupeKind("CREDIT_PURCHASE")).toBe("purchase");
  });

  it("names a kind for every enum value — no silent fallback", () => {
    // The old switch ended in `default: return type`, so a new enum value
    // silently became its own dedupe class. Enumerating from the enum
    // itself is what makes this test fail on the next added value.
    for (const type of revenueEventType.enumValues) {
      expect(
        ["purchase", "reactivation", "refund", "cancel"],
        `no dedupe kind declared for ${type}`,
      ).toContain(revenueDedupeKind(type));
    }
  });
});

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

    // This purchase is not family-shared (seedPurchase leaves
    // ownershipType null), so createRevenueEvent must not suppress.
    if (!inserted) throw new Error("expected a revenue event, got null");

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

  it("folds a store-supplied country into the outbox payload as a top-level field", async () => {
    const project = await seedProject();
    const subscriber = await seedSubscriber(project.id);
    const product = await seedProduct(project.id);
    const purchase = await seedPurchase(project.id, subscriber.id, product.id);

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
      country: "USA",
    });

    if (!inserted) throw new Error("expected a revenue event, got null");

    // Assert on the real stored row, not createRevenueEvent's return value.
    const [outboxRow] = await db
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateType, "REVENUE_EVENT"),
          eq(schema.outboxEvents.aggregateId, inserted.id),
        ),
      );
    const payload = outboxRow!.payload as Record<string, unknown>;
    expect(payload.country).toBe("USA");
  });

  it("omits the country key entirely when the store supplied none — no empty-string stand-in", async () => {
    const project = await seedProject();
    const subscriber = await seedSubscriber(project.id);
    const product = await seedProduct(project.id);
    const purchase = await seedPurchase(project.id, subscriber.id, product.id);

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
      // country omitted — mirrors a store transaction with no storefront.
    });

    if (!inserted) throw new Error("expected a revenue event, got null");

    const [outboxRow] = await db
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateType, "REVENUE_EVENT"),
          eq(schema.outboxEvents.aggregateId, inserted.id),
        ),
      );
    const payload = outboxRow!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("country");
  });

  it("findRevenueEventById returns the row by id, scoped fields intact", async () => {
    const project = await seedProject();
    const subscriber = await seedSubscriber(project.id);
    const product = await seedProduct(project.id);
    const purchase = await seedPurchase(
      project.id,
      subscriber.id,
      product.id,
    );

    const baseEventInput = {
      projectId: project.id,
      subscriberId: subscriber.id,
      purchaseId: purchase.id,
      productId: product.id,
      type: "INITIAL" as const,
      amount: "9.9900",
      currency: "USD",
      amountUsd: "9.9900",
      store: "APP_STORE" as const,
      eventDate: new Date("2026-04-24T00:00:00Z"),
    };

    const created = await createRevenueEvent(db, baseEventInput);
    if (!created) throw new Error("expected a revenue event, got null");
    const found = await findRevenueEventById(db, created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.purchaseId).toBe(created.purchaseId);
    expect(await findRevenueEventById(db, "rev_does_not_exist")).toBeNull();
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
