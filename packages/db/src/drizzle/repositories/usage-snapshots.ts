import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../client";
import {
  usageSnapshots,
  type NewUsageSnapshot,
  type UsageSnapshot,
} from "../schema";
import type { BillingMeterKey } from "../enums";

export async function upsertUsageSnapshot(
  db: Db,
  row: NewUsageSnapshot,
): Promise<UsageSnapshot> {
  const rows = await db
    .insert(usageSnapshots)
    .values(row)
    .onConflictDoUpdate({
      target: [
        usageSnapshots.projectId,
        usageSnapshots.meterKey,
        usageSnapshots.periodStart,
      ],
      set: {
        currentValue: row.currentValue,
        limitValue: row.limitValue ?? null,
        periodEnd: row.periodEnd,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0]!;
}

export async function findUsageSnapshotsForProject(
  db: Db,
  projectId: string,
  periodStart: Date,
): Promise<UsageSnapshot[]> {
  return db
    .select()
    .from(usageSnapshots)
    .where(
      and(
        eq(usageSnapshots.projectId, projectId),
        eq(usageSnapshots.periodStart, periodStart),
      ),
    );
}

export async function findSnapshotsForPeriodStarts(
  db: Db,
  projectId: string,
  periodStarts: Date[],
): Promise<UsageSnapshot[]> {
  return db
    .select()
    .from(usageSnapshots)
    .where(
      and(
        eq(usageSnapshots.projectId, projectId),
        inArray(usageSnapshots.periodStart, periodStarts),
      ),
    );
}

export async function markSoftCapWarned(
  db: Db,
  projectId: string,
  meterKey: BillingMeterKey,
  periodStart: Date,
): Promise<void> {
  await db
    .update(usageSnapshots)
    .set({ softCapWarnedAt: new Date() })
    .where(
      and(
        eq(usageSnapshots.projectId, projectId),
        eq(usageSnapshots.meterKey, meterKey),
        eq(usageSnapshots.periodStart, periodStart),
      ),
    );
}

export async function markHardCapWarned(
  db: Db,
  projectId: string,
  meterKey: BillingMeterKey,
  periodStart: Date,
): Promise<void> {
  await db
    .update(usageSnapshots)
    .set({ hardCapWarnedAt: new Date() })
    .where(
      and(
        eq(usageSnapshots.projectId, projectId),
        eq(usageSnapshots.meterKey, meterKey),
        eq(usageSnapshots.periodStart, periodStart),
      ),
    );
}
