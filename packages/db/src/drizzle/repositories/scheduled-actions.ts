import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  scheduledSubscriptionActions,
  type ScheduledSubscriptionAction,
  type NewScheduledSubscriptionAction,
} from "../schema";

// Accepts both the top-level db and a Drizzle tx handle — the tx
// shape is the same as the db for CRUD. Callers inside
// db.transaction(async (tx) => …) pass `tx`.
type DbOrTx = Db;

export type ScheduledActionRow = ScheduledSubscriptionAction;
export type NewScheduledAction = NewScheduledSubscriptionAction;

// =============================================================
// Writes
// =============================================================

export async function insertScheduledAction(
  db: DbOrTx,
  row: NewScheduledAction,
): Promise<ScheduledActionRow> {
  const [inserted] = await db
    .insert(scheduledSubscriptionActions)
    .values(row)
    .returning();
  if (!inserted) throw new Error("insertScheduledAction: no row returned");
  return inserted;
}

// =============================================================
// Reads
// =============================================================

/**
 * Returns the single PENDING row for the given purchase, or null.
 * Used to enforce "no duplicate pending" before scheduling a new action.
 */
export async function findPendingForPurchase(
  db: Db,
  purchaseId: string,
): Promise<ScheduledActionRow | null> {
  const [row] = await db
    .select()
    .from(scheduledSubscriptionActions)
    .where(
      and(
        eq(scheduledSubscriptionActions.purchaseId, purchaseId),
        eq(scheduledSubscriptionActions.status, "PENDING"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * List all scheduled actions for a project, ordered by dueAt ascending.
 */
export async function listForProject(
  db: Db,
  projectId: string,
  limit: number,
): Promise<ScheduledActionRow[]> {
  return db
    .select()
    .from(scheduledSubscriptionActions)
    .where(eq(scheduledSubscriptionActions.projectId, projectId))
    .orderBy(scheduledSubscriptionActions.dueAt)
    .limit(limit);
}

// =============================================================
// Status transitions
// =============================================================

/**
 * Flip PENDING → CANCELED for a given (id, projectId) pair.
 * The status guard makes the update idempotent — re-cancelling a
 * CANCELED row returns null instead of mutating.
 */
export async function cancelPending(
  db: Db,
  id: string,
  projectId: string,
): Promise<ScheduledActionRow | null> {
  const [row] = await db
    .update(scheduledSubscriptionActions)
    .set({ status: "CANCELED" })
    .where(
      and(
        eq(scheduledSubscriptionActions.id, id),
        eq(scheduledSubscriptionActions.projectId, projectId),
        eq(scheduledSubscriptionActions.status, "PENDING"),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * SELECT … FOR UPDATE SKIP LOCKED — must be called inside a transaction
 * so the row locks are held until the transaction commits.
 */
export async function claimDueBatch(
  db: DbOrTx,
  limit: number,
): Promise<ScheduledActionRow[]> {
  const result = await db.execute(sql`
    SELECT * FROM scheduled_subscription_actions
    WHERE status = 'PENDING' AND "dueAt" <= NOW()
    ORDER BY "dueAt"
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `);
  // drizzle-orm's .execute() returns the node-postgres result shape
  // with `.rows`. Cast to our row type (raw SQL bypasses schema inference).
  return (result as unknown as { rows: ScheduledActionRow[] }).rows ?? [];
}

export async function markExecuted(
  db: DbOrTx,
  id: string,
): Promise<void> {
  await db
    .update(scheduledSubscriptionActions)
    .set({ status: "EXECUTED", executedAt: new Date() })
    .where(eq(scheduledSubscriptionActions.id, id));
}

export async function markFailed(
  db: DbOrTx,
  id: string,
  error: string,
): Promise<void> {
  await db
    .update(scheduledSubscriptionActions)
    .set({ status: "FAILED", executedAt: new Date(), error })
    .where(eq(scheduledSubscriptionActions.id, id));
}
