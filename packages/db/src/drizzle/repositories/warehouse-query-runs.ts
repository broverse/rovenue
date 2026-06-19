import { and, count, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../client";
import { warehouseQueryRuns } from "../schema";

export type NewQueryRun = {
  projectId: string;
  userId: string;
  durationMs?: number | null;
  rowCount?: number | null;
};

export async function recordQueryRun(db: Db, row: NewQueryRun): Promise<void> {
  await db.insert(warehouseQueryRuns).values({
    projectId: row.projectId,
    userId: row.userId,
    durationMs: row.durationMs ?? null,
    rowCount: row.rowCount ?? null,
  });
}

export async function countQueryRunsInPeriod(
  db: Db,
  projectId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(warehouseQueryRuns)
    .where(
      and(
        eq(warehouseQueryRuns.projectId, projectId),
        gte(warehouseQueryRuns.executedAt, periodStart),
        lt(warehouseQueryRuns.executedAt, periodEnd),
      ),
    );
  return Number(row?.value ?? 0);
}
