import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { drizzle, getDb } from "@rovenue/db";
import type { ScheduleActionRequest } from "@rovenue/shared";
import { audit } from "../../lib/audit";

// =============================================================
// scheduleAction, listScheduledForProject, cancelScheduledAction
// =============================================================

const { purchases } = drizzle.schema;
const { scheduledActionsRepo } = drizzle;

export type ScheduledActionRow = Awaited<
  ReturnType<typeof scheduledActionsRepo.insertScheduledAction>
>;

export type ScheduleParams = {
  projectId: string;
  actorUserId: string;
  purchaseId: string;
  input: ScheduleActionRequest;
};

/**
 * Schedule a future action (e.g. CANCEL) on a subscription purchase.
 *
 * Validates:
 *  1. dueAt > now + 60 s
 *  2. Purchase exists and belongs to projectId
 *  3. Purchase is not in a terminal status
 *  4. No PENDING scheduled action already exists for the purchase
 *
 * Opens a single transaction that inserts the scheduled_subscription_actions
 * row and appends an audit_log row atomically.
 */
export async function scheduleAction(
  params: ScheduleParams,
): Promise<ScheduledActionRow> {
  const { projectId, actorUserId, purchaseId, input } = params;

  // 1. dueAt must be > now + 60 seconds
  const dueAtMs = new Date(input.dueAt).getTime();
  if (dueAtMs <= Date.now() + 60_000) {
    throw new HTTPException(400, {
      message: "dueAt must be at least 60s in the future",
    });
  }

  return drizzle.db.transaction(async (tx) => {
    // 2. Look up the purchase
    const [purchase] = await tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .limit(1);

    if (!purchase || purchase.projectId !== projectId) {
      throw new HTTPException(404, { message: "purchase not found" });
    }

    // 3. Reject terminal statuses
    const TERMINAL_STATUSES = new Set(["EXPIRED", "REFUNDED", "REVOKED"]);
    if (TERMINAL_STATUSES.has(purchase.status)) {
      throw new HTTPException(409, {
        message: "purchase is in terminal status",
      });
    }

    // 4. Reject duplicate PENDING
    const existing = await scheduledActionsRepo.findPendingForPurchase(
      tx as unknown as Parameters<typeof scheduledActionsRepo.findPendingForPurchase>[0],
      purchaseId,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: "purchase already has a pending scheduled action",
      });
    }

    // 5. Insert the scheduled action
    const row = await scheduledActionsRepo.insertScheduledAction(
      tx as unknown as Parameters<typeof scheduledActionsRepo.insertScheduledAction>[0],
      {
        projectId,
        purchaseId,
        subscriberId: purchase.subscriberId,
        action: input.action,
        dueAt: new Date(input.dueAt),
        payload: { revokeImmediately: input.revokeImmediately ?? false },
        createdBy: actorUserId,
      },
    );

    // 6. Audit log (atomic with the insert above)
    await audit(
      {
        projectId,
        userId: actorUserId,
        action: "subscription.cancel_scheduled",
        resource: "purchase",
        resourceId: purchaseId,
        before: null,
        after: {
          scheduledActionId: row.id,
          dueAt: row.dueAt.toISOString(),
        },
        ipAddress: null,
        userAgent: null,
      },
      tx,
    );

    return row;
  });
}

/**
 * List all scheduled actions for a project (read-only, no tx needed).
 */
export async function listScheduledForProject(
  projectId: string,
  limit: number,
): Promise<ScheduledActionRow[]> {
  return scheduledActionsRepo.listForProject(getDb(), projectId, limit);
}

export type CancelParams = {
  projectId: string;
  actorUserId: string;
  id: string;
};

/**
 * Cancel a PENDING scheduled action. Opens a transaction so the status
 * update and audit row commit atomically.
 */
export async function cancelScheduledAction(
  params: CancelParams,
): Promise<ScheduledActionRow> {
  const { projectId, actorUserId, id } = params;

  return drizzle.db.transaction(async (tx) => {
    const row = await scheduledActionsRepo.cancelPending(
      tx as unknown as Parameters<typeof scheduledActionsRepo.cancelPending>[0],
      id,
      projectId,
    );

    if (!row) {
      throw new HTTPException(409, {
        message: "scheduled action not pending or not found",
      });
    }

    await audit(
      {
        projectId,
        userId: actorUserId,
        action: "subscription.schedule_canceled",
        resource: "purchase",
        resourceId: row.purchaseId,
        before: { status: "PENDING" },
        after: { status: "CANCELED" },
        ipAddress: null,
        userAgent: null,
      },
      tx,
    );

    return row;
  });
}
