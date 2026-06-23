// =============================================================
// products repo — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import { createProduct, updateProduct, findProductById, listProducts } from "./products";

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
    .values({ name: `products-test-${Date.now()}` })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("productsRepo", () => {
  it("persists and reads androidBasePlanId/androidOfferId", async () => {
    const project = await seedProject();
    const projectId = project.id;

    // create with both fields set
    const created = await createProduct(db, {
      projectId,
      identifier: "pro_x",
      type: "SUBSCRIPTION",
      displayName: "Pro X",
      storeIds: { google: "pro_x" },
      accessIds: [],
      isActive: true,
      metadata: {},
      androidBasePlanId: "annual",
      androidOfferId: "promo10",
    } as any);
    expect(created.androidBasePlanId).toBe("annual");
    expect(created.androidOfferId).toBe("promo10");

    // update: null out androidOfferId, keep androidBasePlanId
    const updated = await updateProduct(db, projectId, created.id, {
      androidOfferId: null,
    });
    expect(updated!.androidBasePlanId).toBe("annual");
    expect(updated!.androidOfferId).toBeNull();

    // findProductById returns full row with the fields
    const found = await findProductById(db, projectId, created.id);
    expect(found!.androidBasePlanId).toBe("annual");
    expect(found!.androidOfferId).toBeNull();

    // create without fields — they should default to null
    const plain = await createProduct(db, {
      projectId,
      identifier: "pro_y",
      type: "SUBSCRIPTION",
      displayName: "Pro Y",
      storeIds: { google: "pro_y" },
      accessIds: [],
      isActive: true,
      metadata: {},
    } as any);
    expect(plain.androidBasePlanId).toBeNull();
    expect(plain.androidOfferId).toBeNull();
  });

  it("listProducts returns androidBasePlanId/androidOfferId on rows", async () => {
    const project = await seedProject();
    const projectId = project.id;

    await createProduct(db, {
      projectId,
      identifier: "list_test",
      type: "SUBSCRIPTION",
      displayName: "List Test",
      storeIds: { google: "list_test" },
      accessIds: [],
      isActive: true,
      metadata: {},
      androidBasePlanId: "monthly",
      androidOfferId: null,
    } as any);

    const rows = await listProducts(db, { projectId });
    const row = rows.find((r) => r.identifier === "list_test");
    expect(row).toBeDefined();
    expect(row!.androidBasePlanId).toBe("monthly");
    expect(row!.androidOfferId).toBeNull();
  });
});
