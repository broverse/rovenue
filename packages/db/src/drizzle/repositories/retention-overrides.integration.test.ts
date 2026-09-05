process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projectRetentionOverrides, projects } from "../schema";
import {
  deleteRetentionOverride,
  listRetentionOverrides,
  upsertRetentionOverride,
} from "./retention-overrides";

// Against the ambient Postgres. The composite primary key and the CHECK
// constraint are the two things worth an integration test here: neither
// can be exercised by a mock, and both are what stop a second write from
// duplicating a window or a caller from storing "delete everything".
//
// Every test seeds what it asserts. An earlier draft let tests 3-6 lean on
// a row test 2 wrote, which made a single `-t` run or a shuffled order
// fail for reasons unrelated to the code.

const RUN_ID = Date.now();
const PROJECT_ID = `prj_pro_${RUN_ID}`;
const OTHER_PROJECT_ID = `prj_pro_other_${RUN_ID}`;
const EMPTY_PROJECT_ID = `prj_pro_empty_${RUN_ID}`;

/** Postgres `check_violation`. */
const CHECK_VIOLATION = "23514";

/**
 * Drizzle rethrows every query failure as a `DrizzleQueryError` with the
 * real `pg` error on `.cause`, so neither `code` nor `constraint` is on
 * the object a caller catches. Walking the chain is the only way to
 * assert on the actual Postgres error — a message substring would match
 * whatever wording the driver happens to use and would keep passing if
 * the constraint were dropped entirely.
 *
 * `apps/api/src/lib/pg-errors.ts` has the same walk, but `packages/db`
 * cannot import from `apps/api`. If a second caller in this package ever
 * needs it, move it here and re-export it there rather than growing a
 * third copy.
 */
function hasPgCode(err: unknown, code: string): boolean {
  for (let e = err, depth = 0; e != null && depth < 5; depth += 1) {
    const link = e as { code?: unknown; cause?: unknown };
    if (link.code === code) return true;
    e = link.cause;
  }
  return false;
}

async function clearOverrides(projectId: string): Promise<void> {
  await getDb()
    .delete(projectRetentionOverrides)
    .where(eq(projectRetentionOverrides.projectId, projectId));
}

describe("retention overrides", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values([
      { id: PROJECT_ID, name: `PRO ${RUN_ID}` },
      { id: OTHER_PROJECT_ID, name: `PRO other ${RUN_ID}` },
      { id: EMPTY_PROJECT_ID, name: `PRO empty ${RUN_ID}` },
    ]);
  });

  afterAll(async () => {
    const db = getDb();
    // ON DELETE CASCADE from projects covers the override rows, but
    // delete them explicitly first so a failure to cascade shows up as a
    // failing cleanup rather than as silent leftovers for the next run.
    for (const id of [PROJECT_ID, OTHER_PROJECT_ID, EMPTY_PROJECT_ID]) {
      await clearOverrides(id);
      await db.delete(projects).where(eq(projects.id, id));
    }
  });

  it("returns an empty map for a project with no overrides", async () => {
    const overrides = await listRetentionOverrides(getDb(), EMPTY_PROJECT_ID);

    // An ordinary answer on the main path, not an exceptional one: the
    // sweep merges this against the registry for every project.
    expect(overrides).toBeInstanceOf(Map);
    expect(overrides.size).toBe(0);
  });

  it("round-trips an override keyed by table name", async () => {
    await clearOverrides(PROJECT_ID);
    await upsertRetentionOverride(getDb(), {
      projectId: PROJECT_ID,
      tableName: "audit_logs",
      retentionDays: 90,
    });

    const overrides = await listRetentionOverrides(getDb(), PROJECT_ID);
    expect(overrides.get("audit_logs")).toBe(90);
  });

  it("upsert replaces rather than duplicating", async () => {
    await clearOverrides(PROJECT_ID);

    await upsertRetentionOverride(getDb(), {
      projectId: PROJECT_ID,
      tableName: "webhook_events",
      retentionDays: 90,
    });
    await upsertRetentionOverride(getDb(), {
      projectId: PROJECT_ID,
      tableName: "webhook_events",
      retentionDays: 30,
    });

    // Both halves matter. The value proves the update landed; the row
    // count proves the composite key prevented a second row, which is
    // what would leave the sweep with two windows for one table.
    const rows = await getDb()
      .select()
      .from(projectRetentionOverrides)
      .where(eq(projectRetentionOverrides.projectId, PROJECT_ID));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.retentionDays).toBe(30);
  });

  it("scopes overrides to their project", async () => {
    await clearOverrides(PROJECT_ID);
    await clearOverrides(OTHER_PROJECT_ID);

    // DISTINCT table names on purpose. With the same name on both
    // projects, dropping the projectId filter leaks a row that collides
    // on the SAME Map key — so the test would pass or fail on unspecified
    // row order rather than on the bug. Different keys make an unscoped
    // read observable every time.
    await upsertRetentionOverride(getDb(), {
      projectId: PROJECT_ID,
      tableName: "audit_logs",
      retentionDays: 90,
    });
    await upsertRetentionOverride(getDb(), {
      projectId: OTHER_PROJECT_ID,
      tableName: "credit_ledger",
      retentionDays: 45,
    });

    const mine = await listRetentionOverrides(getDb(), PROJECT_ID);
    const theirs = await listRetentionOverrides(getDb(), OTHER_PROJECT_ID);

    // The mirror matters as much as the isolation: a repository that
    // returned nothing for everyone would pass an isolation-only check.
    expect(mine.get("audit_logs")).toBe(90);
    expect(theirs.get("credit_ledger")).toBe(45);

    // And neither may see the other's row at all.
    expect(mine.has("credit_ledger")).toBe(false);
    expect(mine.size).toBe(1);
    expect(theirs.has("audit_logs")).toBe(false);
    expect(theirs.size).toBe(1);
  });

  it("rejects a non-positive window at the database", async () => {
    await clearOverrides(PROJECT_ID);

    let caught: unknown;
    try {
      await upsertRetentionOverride(getDb(), {
        projectId: PROJECT_ID,
        tableName: "credit_ledger",
        retentionDays: 0,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(hasPgCode(caught, CHECK_VIOLATION)).toBe(true);

    // And nothing was written — a constraint that rejected the statement
    // but left a row would be worse than none.
    const overrides = await listRetentionOverrides(getDb(), PROJECT_ID);
    expect(overrides.has("credit_ledger")).toBe(false);
  });

  it("deletes one override without touching the project's others", async () => {
    await clearOverrides(PROJECT_ID);
    await upsertRetentionOverride(getDb(), {
      projectId: PROJECT_ID,
      tableName: "audit_logs",
      retentionDays: 90,
    });
    await upsertRetentionOverride(getDb(), {
      projectId: PROJECT_ID,
      tableName: "copilot_messages",
      retentionDays: 14,
    });

    await deleteRetentionOverride(getDb(), PROJECT_ID, "copilot_messages");

    const after = await listRetentionOverrides(getDb(), PROJECT_ID);
    expect(after.has("copilot_messages")).toBe(false);
    // The delete must be scoped to one table, not to the project.
    expect(after.get("audit_logs")).toBe(90);
  });
});
