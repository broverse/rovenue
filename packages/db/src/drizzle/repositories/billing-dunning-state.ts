import { eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  billingDunningState,
  type BillingDunningStateRow,
  type NewBillingDunningStateRow,
} from "../schema";

export async function upsertDunningState(
  db: Db,
  row: NewBillingDunningStateRow,
): Promise<BillingDunningStateRow> {
  const rows = await db
    .insert(billingDunningState)
    .values(row)
    .onConflictDoUpdate({
      target: billingDunningState.projectId,
      set: {
        firstFailureAt: row.firstFailureAt,
        attemptCount: row.attemptCount,
        currentPhase: row.currentPhase ?? null,
        uiLockedAt: row.uiLockedAt ?? null,
        sdkLockedAt: row.sdkLockedAt ?? null,
        recoveredAt: row.recoveredAt ?? null,
        lastEmailSentAt: row.lastEmailSentAt ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0]!;
}

export async function findDunningStateForProject(
  db: Db,
  projectId: string,
): Promise<BillingDunningStateRow | null> {
  const rows = await db
    .select()
    .from(billingDunningState)
    .where(eq(billingDunningState.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

export async function clearDunningState(
  db: Db,
  projectId: string,
): Promise<void> {
  await db
    .delete(billingDunningState)
    .where(eq(billingDunningState.projectId, projectId));
}
