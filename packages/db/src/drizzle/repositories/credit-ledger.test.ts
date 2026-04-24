// =============================================================
// credit-ledger repo — integration tests (real Postgres)
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
import { insertCreditLedger } from "./credit-ledger";

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
    .values({ name: "Test Project", slug: `test-proj-cl-${Date.now()}` })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project;
}

async function seedSubscriber(projectId: string) {
  const [subscriber] = await db
    .insert(schema.subscribers)
    .values({ projectId, appUserId: `user-cl-${Date.now()}` })
    .returning();
  if (!subscriber) throw new Error("seedSubscriber: no row returned");
  return subscriber;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("insertCreditLedger", () => {
  it("writes exactly one outbox row per credit ledger row", async () => {
    const project = await seedProject();
    const subscriber = await seedSubscriber(project.id);

    const inserted = await insertCreditLedger(db, {
      projectId: project.id,
      subscriberId: subscriber.id,
      type: "PURCHASE",
      amount: 100,
      balance: 100,
      referenceType: null,
      referenceId: null,
    });

    // 1. Credit ledger row exists and ID matches the return value.
    const ledgerRows = await db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.id, inserted.id));
    expect(ledgerRows).toHaveLength(1);

    // 2. Exactly one CREDIT_LEDGER outbox row with matching aggregateId.
    const outboxRows = await db
      .select()
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateType, "CREDIT_LEDGER"),
          eq(schema.outboxEvents.aggregateId, inserted.id),
        ),
      );
    expect(outboxRows).toHaveLength(1);

    // 3. Payload shape matches what the CH MV extractor expects.
    const payload = outboxRows[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      creditLedgerId: inserted.id,
      projectId: project.id,
      subscriberId: subscriber.id,
      type: "PURCHASE",
      amount: 100,       // number, not string "100"
      balance: 100,      // number, not string "100"
      referenceType: null, // actual null, not empty string
      referenceId: null,   // actual null, not empty string
      createdAt: inserted.createdAt.toISOString(),
    });
    expect(outboxRows[0]!.eventType).toBe("credit.ledger.appended");
  });

  it("rolls back both writes if the credit ledger row fails (FK violation)", async () => {
    const project = await seedProject();

    const nonExistentSubscriberId = "nonexistent-subscriber-id-that-does-not-exist";

    await expect(
      insertCreditLedger(db, {
        projectId: project.id,
        subscriberId: nonExistentSubscriberId,
        type: "PURCHASE",
        amount: 50,
        balance: 50,
      }),
    ).rejects.toThrow();

    // Credit ledger row must NOT exist.
    const ledgerCount = await db
      .select({ count: sql<string>`count(*)` })
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.subscriberId, nonExistentSubscriberId));
    expect(Number(ledgerCount[0]!.count)).toBe(0);

    // Outbox row must NOT exist.
    const outboxCount = await db
      .select({ count: sql<string>`count(*)` })
      .from(schema.outboxEvents)
      .where(
        and(
          eq(schema.outboxEvents.aggregateType, "CREDIT_LEDGER"),
          eq(schema.outboxEvents.aggregateId, nonExistentSubscriberId),
        ),
      );
    expect(Number(outboxCount[0]!.count)).toBe(0);
  });
});
