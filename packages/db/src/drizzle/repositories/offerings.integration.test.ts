// =============================================================
// offerings schema — decoupled + packages integration tests
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Pattern mirrors the sibling subscribers.resolve / webhook-events
// integration suites.
//
// Covers:
//   - Insert with packages array (no accessId column)
//   - Partial unique index rejects a second isDefault=true offering
//     for the same project

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { offerings, projects } from "../schema";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_offerings_${RUN_ID}`;

describe("offerings schema (decoupled + packages)", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Offerings ${RUN_ID}` });
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(offerings).where(eq(offerings.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("inserts an offering with packages array and no accessId column", async () => {
    const db = getDb();
    const [row] = await db
      .insert(offerings)
      .values({
        projectId: PROJECT_ID,
        identifier: "default",
        isDefault: true,
        packages: [
          {
            identifier: "$rc_monthly",
            productId: `prod_${RUN_ID}`,
            order: 0,
            isPromoted: false,
          },
        ],
      })
      .returning();

    expect(row).toBeDefined();
    expect(Array.isArray(row!.packages)).toBe(true);
    expect((row!.packages as unknown[]).length).toBe(1);
    expect((row!.packages as Array<{ identifier: string }>)[0]!.identifier).toBe(
      "$rc_monthly",
    );
    // Confirm the Drizzle type has no accessId property
    expect("accessId" in row!).toBe(false);
  });

  it("rejects a second isDefault=true offering for the same project", async () => {
    const db = getDb();
    // First default for a second project so we don't conflict with the
    // row already inserted by the previous test.
    const secondProjectId = `${PROJECT_ID}_b`;
    await db
      .insert(projects)
      .values({ id: secondProjectId, name: `Offerings B ${RUN_ID}` });

    await db.insert(offerings).values({
      projectId: secondProjectId,
      identifier: "offering_a",
      isDefault: true,
      packages: [],
    });

    await expect(
      db.insert(offerings).values({
        projectId: secondProjectId,
        identifier: "offering_b",
        isDefault: true,
        packages: [],
      }),
    ).rejects.toThrow();

    // Cleanup
    await db.delete(offerings).where(eq(offerings.projectId, secondProjectId));
    await db.delete(projects).where(eq(projects.id, secondProjectId));
  });
});
