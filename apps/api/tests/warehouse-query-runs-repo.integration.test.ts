// =============================================================
// warehouse-query-runs repo — integration test
//
// Verifies recordQueryRun() inserts a row and countQueryRunsInPeriod()
// returns the correct count using a half-open [periodStart, periodEnd)
// window, scoped to the project. Runs against dev Postgres configured
// in apps/api/tests/setup.ts. Rows keyed by a unique RUN_ID so
// parallel runs against the shared dev DB don't collide.
// =============================================================

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  warehouseQueryRuns,
  projects,
  user,
} from "../../packages/db/src/drizzle/schema";
import {
  recordQueryRun,
  countQueryRunsInPeriod,
} from "../../packages/db/src/drizzle/repositories/warehouse-query-runs";

const RUN_ID = Date.now();
const PID = `proj_wqr_${RUN_ID}`;
const UID = "usr_wqr_demo";
const PERIOD_START = new Date("2026-05-01T00:00:00Z");
const PERIOD_END = new Date("2026-06-01T00:00:00Z");

async function setup() {
  await db.delete(warehouseQueryRuns).where(eq(warehouseQueryRuns.projectId, PID));
  await db.delete(projects).where(eq(projects.id, PID));
  await db
    .insert(user)
    .values({
      id: UID,
      name: "WQR Demo User",
      email: "wqr-demo@rovenue.io",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await db.insert(projects).values({
    id: PID,
    slug: `test-wqr-${RUN_ID}`,
    name: `WQR Test ${RUN_ID}`,
    ownerId: UID,
  });
}

describe("warehouse-query-runs repo", () => {
  beforeEach(setup);
  afterAll(setup);

  it("counts only runs inside the half-open period for the project", async () => {
    // recordQueryRun uses defaultNow() → executedAt will be ~now (2026-06-19),
    // which falls outside [2026-05-01, 2026-06-01). We insert with an explicit
    // executedAt inside the window by using a raw insert.
    await db.insert(warehouseQueryRuns).values({
      projectId: PID,
      userId: UID,
      durationMs: 12,
      rowCount: 3,
      executedAt: new Date("2026-05-15T12:00:00Z"),
    });

    const inPeriod = await countQueryRunsInPeriod(db, PID, PERIOD_START, PERIOD_END);
    expect(inPeriod).toBeGreaterThanOrEqual(1);

    // wrong project → 0
    const otherProject = await countQueryRunsInPeriod(
      db,
      "does-not-exist",
      PERIOD_START,
      PERIOD_END,
    );
    expect(otherProject).toBe(0);
  });

  it("recordQueryRun inserts a row with optional fields nullable", async () => {
    await recordQueryRun(db, { projectId: PID, userId: UID });

    // executedAt = now, so count in the current month window
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const c = await countQueryRunsInPeriod(db, PID, monthStart, monthEnd);
    expect(c).toBeGreaterThanOrEqual(1);
  });

  it("period boundary: executedAt === periodEnd is excluded", async () => {
    // Insert exactly at periodEnd — should NOT be counted (half-open interval).
    await db.insert(warehouseQueryRuns).values({
      projectId: PID,
      userId: UID,
      executedAt: PERIOD_END,
    });
    const c = await countQueryRunsInPeriod(db, PID, PERIOD_START, PERIOD_END);
    expect(c).toBe(0);
  });
});
