// =============================================================
// billing-payment-methods repo — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import {
  deleteByStripePaymentMethodId,
  findByStripePaymentMethodId,
  insertPaymentMethod,
  listPaymentMethodsForProject,
} from "./billing-payment-methods";

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
    .values({ name: "Test Project (pm)" })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project;
}

function uniqueStripePmId() {
  return `pm_test_${randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findByStripePaymentMethodId", () => {
  it("returns the inserted row when a matching Stripe id exists", async () => {
    const project = await seedProject();
    const stripePmId = uniqueStripePmId();

    const inserted = await insertPaymentMethod(db, {
      projectId: project.id,
      stripePaymentMethodId: stripePmId,
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: false,
    });

    const found = await findByStripePaymentMethodId(db, stripePmId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(inserted.id);
    expect(found!.projectId).toBe(project.id);
    expect(found!.stripePaymentMethodId).toBe(stripePmId);
  });

  it("returns null when no row matches the Stripe id", async () => {
    const found = await findByStripePaymentMethodId(
      db,
      `pm_missing_${randomUUID().slice(0, 8)}`,
    );
    expect(found).toBeNull();
  });
});

describe("deleteByStripePaymentMethodId", () => {
  it("removes the row identified by stripe_payment_method_id", async () => {
    const project = await seedProject();
    const stripePmId = uniqueStripePmId();

    await insertPaymentMethod(db, {
      projectId: project.id,
      stripePaymentMethodId: stripePmId,
      brand: "mastercard",
      last4: "5454",
      expMonth: 6,
      expYear: 2029,
      isDefault: false,
    });

    // Sanity: row exists for the project.
    const before = await listPaymentMethodsForProject(db, project.id);
    expect(before).toHaveLength(1);

    await deleteByStripePaymentMethodId(db, stripePmId);

    const after = await listPaymentMethodsForProject(db, project.id);
    expect(after).toHaveLength(0);
  });
});
