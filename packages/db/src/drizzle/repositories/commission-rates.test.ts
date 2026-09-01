// =============================================================
// commission-rates repo — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import {
  deleteCommissionRate,
  getCommissionRate,
  listCommissionRates,
  upsertCommissionRate,
} from "./commission-rates";

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
    .values({ name: `commission-rates-test-${Date.now()}-${Math.random()}` })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("commissionRateRepo", () => {
  it("returns null for a project+store with no configured rate", async () => {
    const project = await seedProject();
    const row = await getCommissionRate(db, project.id, "APP_STORE");
    expect(row).toBeNull();
  });

  it("upserts, reads back, and overwrites (not duplicates) a rate for one project+store", async () => {
    const project = await seedProject();

    const created = await upsertCommissionRate(db, {
      projectId: project.id,
      store: "APP_STORE",
      rate: "0.3000",
    });
    expect(Number(created.rate)).toBeCloseTo(0.3, 8);

    const fetched = await getCommissionRate(db, project.id, "APP_STORE");
    expect(fetched).not.toBeNull();
    expect(Number(fetched!.rate)).toBeCloseTo(0.3, 8);

    // The customer re-qualifies for the Small Business Program — the same
    // (project, store) pair is overwritten, not duplicated.
    const updated = await upsertCommissionRate(db, {
      projectId: project.id,
      store: "APP_STORE",
      rate: "0.1500",
    });
    expect(Number(updated.rate)).toBeCloseTo(0.15, 8);

    const rows = await listCommissionRates(db, project.id);
    const appleRows = rows.filter((r) => r.store === "APP_STORE");
    expect(appleRows).toHaveLength(1);
    expect(Number(appleRows[0]!.rate)).toBeCloseTo(0.15, 8);
  });

  it("keeps independent rates per store on the same project", async () => {
    const project = await seedProject();

    await upsertCommissionRate(db, {
      projectId: project.id,
      store: "APP_STORE",
      rate: "0.3000",
    });
    await upsertCommissionRate(db, {
      projectId: project.id,
      store: "PLAY_STORE",
      rate: "0.1500",
    });

    const rows = await listCommissionRates(db, project.id);
    expect(rows).toHaveLength(2);

    const apple = await getCommissionRate(db, project.id, "APP_STORE");
    const google = await getCommissionRate(db, project.id, "PLAY_STORE");
    expect(Number(apple!.rate)).toBeCloseTo(0.3, 8);
    expect(Number(google!.rate)).toBeCloseTo(0.15, 8);
  });

  it("rejects a rate outside [0, 1] at the database level (CHECK constraint)", async () => {
    const project = await seedProject();
    await expect(
      upsertCommissionRate(db, {
        projectId: project.id,
        store: "APP_STORE",
        rate: "1.5000",
      }),
    ).rejects.toThrow();
  });

  it("deleteCommissionRate reverts a project+store back to unconfigured", async () => {
    const project = await seedProject();
    await upsertCommissionRate(db, {
      projectId: project.id,
      store: "STRIPE",
      rate: "0.0290",
    });
    expect(await getCommissionRate(db, project.id, "STRIPE")).not.toBeNull();

    await deleteCommissionRate(db, project.id, "STRIPE");
    expect(await getCommissionRate(db, project.id, "STRIPE")).toBeNull();
  });
});
