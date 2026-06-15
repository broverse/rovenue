import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  usageSnapshots,
  projects,
  user,
} from "../../packages/db/src/drizzle/schema";
import {
  upsertUsageSnapshot,
  findUsageSnapshotsForProject,
  markSoftCapWarned,
  markHardCapWarned,
} from "../../packages/db/src/drizzle/repositories/usage-snapshots";

const PID = "proj_test_usage";
const PSTART = new Date("2026-05-01T00:00:00Z");
const PEND = new Date("2026-06-01T00:00:00Z");

async function setup() {
  await db.delete(usageSnapshots).where(eq(usageSnapshots.projectId, PID));
  await db.delete(projects).where(eq(projects.id, PID));
  await db
    .insert(user)
    .values({
      id: "usr_demo",
      name: "Demo User",
      email: "demo@rovenue.io",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await db.insert(projects).values({
    id: PID,
    slug: "test-usage",
    name: "Test Usage",
    ownerId: "usr_demo",
  });
}

describe("usage-snapshots repository", () => {
  beforeEach(setup);
  afterAll(setup);

  it("upsert inserts on first call", async () => {
    const r = await upsertUsageSnapshot(db, {
      projectId: PID,
      meterKey: "mtr",
      periodStart: PSTART,
      periodEnd: PEND,
      currentValue: "1234.5678",
      limitValue: "3000.0000",
    });
    expect(r.currentValue).toBe("1234.5678");
  });

  it("upsert updates on second call (same key)", async () => {
    await upsertUsageSnapshot(db, {
      projectId: PID,
      meterKey: "mtr",
      periodStart: PSTART,
      periodEnd: PEND,
      currentValue: "100",
      limitValue: "3000",
    });
    const r = await upsertUsageSnapshot(db, {
      projectId: PID,
      meterKey: "mtr",
      periodStart: PSTART,
      periodEnd: PEND,
      currentValue: "500",
      limitValue: "3000",
    });
    expect(r.currentValue).toBe("500.0000");
  });

  it("findUsageSnapshotsForProject returns the rows", async () => {
    for (const key of ["mtr", "events", "sql_queries"] as const) {
      await upsertUsageSnapshot(db, {
        projectId: PID,
        meterKey: key,
        periodStart: PSTART,
        periodEnd: PEND,
        currentValue: "0",
        limitValue: null,
      });
    }
    const rows = await findUsageSnapshotsForProject(db, PID, PSTART);
    expect(rows).toHaveLength(3);
  });

  it("markSoftCapWarned sets the timestamp idempotently", async () => {
    await upsertUsageSnapshot(db, {
      projectId: PID,
      meterKey: "mtr",
      periodStart: PSTART,
      periodEnd: PEND,
      currentValue: "2500",
      limitValue: "3000",
    });
    await markSoftCapWarned(db, PID, "mtr", PSTART);
    const [row] = await db
      .select()
      .from(usageSnapshots)
      .where(
        and(
          eq(usageSnapshots.projectId, PID),
          eq(usageSnapshots.meterKey, "mtr"),
          eq(usageSnapshots.periodStart, PSTART),
        ),
      );
    expect(row.softCapWarnedAt).not.toBeNull();
  });
});
