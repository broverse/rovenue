import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../client";
import {
  refundShieldResponses,
  type RefundShieldResponse,
} from "../schema";

// `DbOrTx` mirrors the convention used by every other repository in
// this package — the Drizzle tx handle has the same insert/select
// surface as the top-level db client, so a single type alias covers
// both call sites.
type DbOrTx = Db;

export type RefundShieldStatus =
  | "PENDING"
  | "SENT"
  | "FAILED"
  | "SKIPPED_NOT_FOUND"
  | "SKIPPED_DISABLED";

export type RefundShieldOutcome =
  | "REFUND_APPROVED"
  | "REFUND_DECLINED"
  | "REFUND_REVERSED";

export interface InsertConsumptionRequestInput {
  projectId: string;
  subscriberId: string | null;
  appleNotificationUuid: string;
  appleOriginalTransactionId: string;
  appleTransactionId: string;
  detectedAt: Date;
  scheduledFor: Date;
  status: RefundShieldStatus;
}

/**
 * Idempotent insert of a CONSUMPTION_REQUEST work-queue row. The
 * unique index on `apple_notification_uuid` guarantees the second
 * delivery of the same Apple notification is a no-op — this is the
 * idempotency guarantee that lets the Apple webhook safely retry
 * without producing duplicate responder work.
 */
export async function insertConsumptionRequest(
  db: DbOrTx,
  input: InsertConsumptionRequestInput,
): Promise<void> {
  await db
    .insert(refundShieldResponses)
    .values({
      projectId: input.projectId,
      subscriberId: input.subscriberId,
      appleNotificationUuid: input.appleNotificationUuid,
      appleOriginalTransactionId: input.appleOriginalTransactionId,
      appleTransactionId: input.appleTransactionId,
      detectedAt: input.detectedAt,
      scheduledFor: input.scheduledFor,
      status: input.status,
    })
    .onConflictDoNothing({ target: refundShieldResponses.appleNotificationUuid });
}

/**
 * Lookup by notification UUID — exposed for tests / dashboard.
 * Returns the first (and, by unique index, only) matching row.
 */
export async function findByNotificationUuid(
  db: Db,
  appleNotificationUuid: string,
): Promise<RefundShieldResponse | null> {
  const rows = await db
    .select()
    .from(refundShieldResponses)
    .where(eq(refundShieldResponses.appleNotificationUuid, appleNotificationUuid))
    .limit(1);
  return rows[0] ?? null;
}

export interface UpdateOutcomeInput {
  projectId: string;
  originalTransactionId: string;
  outcome: RefundShieldOutcome;
}

// Outcome wiring uses TWO methods rather than a single
// boolean-parameterised one, because the two call sites have
// genuinely different semantics:
//
//   - REFUND / REFUND_DECLINED arrive once and should NEVER overwrite
//     a prior outcome — they record the initial decision (first-wins).
//   - REFUND_REVERSED arrives after an earlier REFUND_APPROVED and
//     MUST overwrite to flip the outcome.
//
// Splitting also makes the WHERE-clause asymmetry explicit at the
// call site, avoiding the classic "boolean flag becomes a footgun"
// when a future caller forgets which side they want.
//
// Both methods are no-ops when zero rows match — orphan REFUND
// notifications (no prior CONSUMPTION_REQUEST) silently match nothing
// and the outer revenue-events logic still runs.

/**
 * Set outcome ONLY when it is currently NULL. Used for the initial
 * REFUND / REFUND_DECLINED notifications so a later, conflicting
 * outcome cannot quietly stomp on the first-recorded decision.
 */
export async function updateOutcomeByOriginalTransactionIdIfNull(
  db: DbOrTx,
  input: UpdateOutcomeInput,
): Promise<void> {
  const now = new Date();
  await db
    .update(refundShieldResponses)
    .set({
      outcome: input.outcome,
      outcomeReceivedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(refundShieldResponses.projectId, input.projectId),
        eq(
          refundShieldResponses.appleOriginalTransactionId,
          input.originalTransactionId,
        ),
        isNull(refundShieldResponses.outcome),
      ),
    );
}

/**
 * Set outcome unconditionally. Used for REFUND_REVERSED, which is
 * always a later overwrite of a prior REFUND_APPROVED.
 */
export async function updateOutcomeByOriginalTransactionIdOverwrite(
  db: DbOrTx,
  input: UpdateOutcomeInput,
): Promise<void> {
  const now = new Date();
  await db
    .update(refundShieldResponses)
    .set({
      outcome: input.outcome,
      outcomeReceivedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(refundShieldResponses.projectId, input.projectId),
        eq(
          refundShieldResponses.appleOriginalTransactionId,
          input.originalTransactionId,
        ),
      ),
    );
}
