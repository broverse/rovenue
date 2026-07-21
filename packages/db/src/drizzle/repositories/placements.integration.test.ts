// =============================================================
// placementRepo — integration tests
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Pattern mirrors the sibling offerings.integration.test.ts suite.
//
// Covers:
//   - create / list / find by identifier
//   - unique (projectId, identifier) violation
//   - updatePlacement bumps revision 1 -> 2 when `rows` is present
//   - updatePlacement does NOT bump revision when `rows` is absent
//   - delete

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { placements, projects } from "../schema";
import * as placementRepo from "./placements";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_placements_${RUN_ID}`;

describe("placementRepo", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Placements ${RUN_ID}` });
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(placements).where(eq(placements.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("creates a placement and lists it", async () => {
    const db = getDb();
    const created = await placementRepo.createPlacement(db, {
      projectId: PROJECT_ID,
      identifier: "main",
      name: "Main Placement",
    });

    expect(created.id).toBeDefined();
    expect(created.identifier).toBe("main");
    expect(created.revision).toBe(1);
    expect(created.rows).toEqual([]);

    const list = await placementRepo.listPlacements(db, PROJECT_ID);
    expect(list.some((p) => p.id === created.id)).toBe(true);
  });

  it("finds a placement by identifier", async () => {
    const db = getDb();
    const created = await placementRepo.createPlacement(db, {
      projectId: PROJECT_ID,
      identifier: "find_me",
      name: "Find Me",
    });

    const found = await placementRepo.findPlacementByIdentifier(
      db,
      PROJECT_ID,
      "find_me",
    );
    expect(found?.id).toBe(created.id);

    const missing = await placementRepo.findPlacementByIdentifier(
      db,
      PROJECT_ID,
      "does_not_exist",
    );
    expect(missing).toBeNull();
  });

  it("rejects a second placement with the same (projectId, identifier)", async () => {
    const db = getDb();
    await placementRepo.createPlacement(db, {
      projectId: PROJECT_ID,
      identifier: "dup_id",
      name: "Dup 1",
    });

    await expect(
      placementRepo.createPlacement(db, {
        projectId: PROJECT_ID,
        identifier: "dup_id",
        name: "Dup 2",
      }),
    ).rejects.toThrow();
  });

  it("bumps revision from 1 to 2 when `rows` is present in the patch", async () => {
    const db = getDb();
    const created = await placementRepo.createPlacement(db, {
      projectId: PROJECT_ID,
      identifier: "revisioned",
      name: "Revisioned",
    });
    expect(created.revision).toBe(1);

    const updated = await placementRepo.updatePlacement(
      db,
      PROJECT_ID,
      created.id,
      {
        rows: [
          { audienceId: null, target: { type: "none" } },
        ],
      },
    );

    expect(updated?.revision).toBe(2);
    expect((updated?.rows as unknown[]).length).toBe(1);

    const updatedAgain = await placementRepo.updatePlacement(
      db,
      PROJECT_ID,
      created.id,
      {
        rows: [
          { audienceId: null, target: { type: "none" } },
          { audienceId: null, target: { type: "none" } },
        ],
      },
    );
    expect(updatedAgain?.revision).toBe(3);
  });

  it("does NOT bump revision when `rows` is absent from the patch", async () => {
    const db = getDb();
    const created = await placementRepo.createPlacement(db, {
      projectId: PROJECT_ID,
      identifier: "no_bump",
      name: "Before",
    });
    expect(created.revision).toBe(1);

    const updated = await placementRepo.updatePlacement(
      db,
      PROJECT_ID,
      created.id,
      { name: "After" },
    );

    expect(updated?.name).toBe("After");
    expect(updated?.revision).toBe(1);
  });

  it("deletes a placement", async () => {
    const db = getDb();
    const created = await placementRepo.createPlacement(db, {
      projectId: PROJECT_ID,
      identifier: "deletable",
      name: "Deletable",
    });

    const result = await placementRepo.deletePlacement(db, PROJECT_ID, created.id);
    expect(result).toBe(true);

    const gone = await placementRepo.findPlacementByIdentifier(
      db,
      PROJECT_ID,
      "deletable",
    );
    expect(gone).toBeNull();
  });

  it("deletePlacement returns false when the placement does not exist", async () => {
    const db = getDb();
    const result = await placementRepo.deletePlacement(db, PROJECT_ID, "does_not_exist");
    expect(result).toBe(false);
  });
});
