// =============================================================
// access-catalog repo — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import {
  create,
  deleteById,
  findById,
  findByIdentifier,
  findByIds,
  list,
  update,
} from "./access-catalog";

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
    .values({ name: `access-catalog-test-${Date.now()}` })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("accessCatalogRepo", () => {
  it("creates, lists, gets by id/identifier, updates, and deletes", async () => {
    const project = await seedProject();

    // create
    const created = await create(db, {
      projectId: project.id,
      identifier: "pro",
      displayName: "Pro Access",
    });
    expect(created.identifier).toBe("pro");
    expect(created.displayName).toBe("Pro Access");
    expect(created.projectId).toBe(project.id);
    expect(created.id).toBeTruthy();

    // list — scoped to this project (deterministic; project just created)
    const listed = await list(db, project.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);

    // findById
    const byId = await findById(db, created.id);
    expect(byId?.id).toBe(created.id);

    // findByIdentifier
    const byIdent = await findByIdentifier(db, project.id, "pro");
    expect(byIdent?.id).toBe(created.id);

    // findByIdentifier — miss
    const miss = await findByIdentifier(db, project.id, "does-not-exist");
    expect(miss).toBeNull();

    // findByIds
    const byIds = await findByIds(db, [created.id]);
    expect(byIds).toHaveLength(1);
    expect(byIds[0]!.id).toBe(created.id);

    // findByIds — empty input short-circuits
    const empty = await findByIds(db, []);
    expect(empty).toEqual([]);

    // update
    await update(db, created.id, { displayName: "Pro+" });
    const updated = await findById(db, created.id);
    expect(updated?.displayName).toBe("Pro+");
    // updatedAt should advance
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      created.updatedAt.getTime(),
    );

    // deleteById
    await deleteById(db, created.id);
    const afterDelete = await findById(db, created.id);
    expect(afterDelete).toBeNull();
  });

  it("findById returns null for unknown id", async () => {
    const row = await findById(db, "does-not-exist-id");
    expect(row).toBeNull();
  });
});
