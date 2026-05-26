// =============================================================
// billing-subscriptions repo — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
//
// Setup mirrors apps/api/tests/setup.ts: env fallbacks target the
// docker-compose service so tests run without extra configuration.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import {
  createFreeBillingSubscription,
  findBillingSubscriptionByProject,
  findByStripeCustomerId,
  findBySubscriptionId,
  setStripeCustomerId,
  updateAfterStripeCreated,
  updateAfterStripeUpdated,
} from "./billing-subscriptions";

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

// Unique-ish ids per test to dodge any cross-test collisions.
function stripeCustomerId() {
  return `cus_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function stripeSubscriptionId() {
  return `sub_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setStripeCustomerId", () => {
  it("mutates only stripe_customer_id (state stays 'free')", async () => {
    const project = await seedProject();
    const row = await createFreeBillingSubscription(db, project.id);
    expect(row.state).toBe("free");
    expect(row.stripeCustomerId).toBeNull();

    const cust = stripeCustomerId();
    await setStripeCustomerId(db, project.id, cust);

    const after = await findBillingSubscriptionByProject(db, project.id);
    expect(after).not.toBeNull();
    expect(after!.stripeCustomerId).toBe(cust);
    expect(after!.state).toBe("free");
    expect(after!.tier).toBe("free");
    expect(after!.cycle).toBe("monthly");
    // updated_at must have advanced (>= original updatedAt).
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      row.updatedAt.getTime(),
    );
  });
});

describe("findByStripeCustomerId", () => {
  it("returns the project's row after setStripeCustomerId", async () => {
    const project = await seedProject();
    await createFreeBillingSubscription(db, project.id);

    const cust = stripeCustomerId();
    await setStripeCustomerId(db, project.id, cust);

    const found = await findByStripeCustomerId(db, cust);
    expect(found).not.toBeNull();
    expect(found!.projectId).toBe(project.id);
    expect(found!.stripeCustomerId).toBe(cust);
  });

  it("returns null for an unknown customer id", async () => {
    const found = await findByStripeCustomerId(db, "cus_does_not_exist");
    expect(found).toBeNull();
  });
});

describe("updateAfterStripeCreated", () => {
  it("flips state='active' and writes tier/cycle/period fields", async () => {
    const project = await seedProject();
    await createFreeBillingSubscription(db, project.id);

    const subId = stripeSubscriptionId();
    const periodStart = new Date("2026-05-01T00:00:00.000Z");
    const periodEnd = new Date("2026-06-01T00:00:00.000Z");

    await updateAfterStripeCreated(db, project.id, {
      stripeSubscriptionId: subId,
      tier: "indie",
      cycle: "monthly",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });

    const after = await findBillingSubscriptionByProject(db, project.id);
    expect(after).not.toBeNull();
    expect(after!.state).toBe("active");
    expect(after!.tier).toBe("indie");
    expect(after!.cycle).toBe("monthly");
    expect(after!.stripeSubscriptionId).toBe(subId);
    expect(after!.currentPeriodStart?.toISOString()).toBe(
      periodStart.toISOString(),
    );
    expect(after!.currentPeriodEnd?.toISOString()).toBe(
      periodEnd.toISOString(),
    );
  });
});

describe("findBySubscriptionId", () => {
  it("returns null for unknown subscription id", async () => {
    const found = await findBySubscriptionId(db, "sub_does_not_exist");
    expect(found).toBeNull();
  });

  it("returns the row when subscription id matches", async () => {
    const project = await seedProject();
    await createFreeBillingSubscription(db, project.id);
    const subId = stripeSubscriptionId();
    await updateAfterStripeCreated(db, project.id, {
      stripeSubscriptionId: subId,
      tier: "pro",
      cycle: "annual",
      currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
    });

    const found = await findBySubscriptionId(db, subId);
    expect(found).not.toBeNull();
    expect(found!.projectId).toBe(project.id);
    expect(found!.tier).toBe("pro");
    expect(found!.cycle).toBe("annual");
  });
});

describe("updateAfterStripeUpdated", () => {
  it("patches period+tier+cycle and leaves state='active'", async () => {
    const project = await seedProject();
    await createFreeBillingSubscription(db, project.id);
    const subId = stripeSubscriptionId();
    await updateAfterStripeCreated(db, project.id, {
      stripeSubscriptionId: subId,
      tier: "indie",
      cycle: "monthly",
      currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
    });

    const newStart = new Date("2026-06-01T00:00:00.000Z");
    const newEnd = new Date("2026-07-01T00:00:00.000Z");
    await updateAfterStripeUpdated(db, subId, {
      tier: "pro",
      cycle: "monthly",
      currentPeriodStart: newStart,
      currentPeriodEnd: newEnd,
    });

    const after = await findBySubscriptionId(db, subId);
    expect(after).not.toBeNull();
    expect(after!.state).toBe("active");
    expect(after!.tier).toBe("pro");
    expect(after!.cycle).toBe("monthly");
    expect(after!.currentPeriodStart?.toISOString()).toBe(newStart.toISOString());
    expect(after!.currentPeriodEnd?.toISOString()).toBe(newEnd.toISOString());
  });
});
