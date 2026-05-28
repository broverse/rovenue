import { and, eq, isNull, sql } from "drizzle-orm";
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

// Per-row Apple environment captured from the JWS at webhook
// receipt time. The responder worker reads it back to pick the
// correct App Store Server API base URL — see
// refund-shield-responder.ts `loadAppleContextForProject`.
export type RefundShieldAppleEnvironment = "PRODUCTION" | "SANDBOX";

export interface InsertConsumptionRequestInput {
  projectId: string;
  subscriberId: string | null;
  appleNotificationUuid: string;
  appleOriginalTransactionId: string;
  appleTransactionId: string;
  detectedAt: Date;
  scheduledFor: Date;
  status: RefundShieldStatus;
  appleEnvironment: RefundShieldAppleEnvironment;
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
      appleEnvironment: input.appleEnvironment,
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

// =============================================================
// Responder worker (T14) helpers
// =============================================================
//
// `FOR UPDATE SKIP LOCKED` lets multiple replicas of the polling
// worker safely contend for the same backlog: each transaction
// grabs an exclusive lock on its claimed rows and skips any rows
// another worker already locked. The Drizzle query builder does
// not expose a typed `FOR UPDATE SKIP LOCKED` chainable, so we
// drop to raw SQL — same pattern the outgoing-webhook claim uses.

/**
 * Shape returned by `claimPendingResponses`. Mirrors the columns
 * `processRefundShieldResponse` needs at the worker hot path.
 * Re-declared (rather than re-exporting `RefundShieldResponse`)
 * so the SQL projection stays narrow and the type doesn't drift
 * with future schema changes.
 */
export interface PendingResponseRow {
  id: string;
  projectId: string;
  subscriberId: string | null;
  appleNotificationUuid: string;
  appleOriginalTransactionId: string;
  appleTransactionId: string;
  detectedAt: Date;
  scheduledFor: Date;
  status: string;
  retryCount: number;
  // Persisted at CONSUMPTION_REQUEST insert time from the JWS —
  // worker uses it to pick the App Store Server API base URL
  // rather than falling back to NODE_ENV.
  appleEnvironment: RefundShieldAppleEnvironment;
}

/**
 * Claim a batch of PENDING rows whose `scheduledFor` has arrived
 * and whose `retryCount` is below `maxRetries`. Returns the rows
 * locked in the caller's transaction via `FOR UPDATE SKIP LOCKED`
 * — concurrent worker replicas will pick disjoint batches.
 *
 * Requires a real Postgres connection — MVCC + row locks don't
 * exist on the SQLite test engine. Unit tests mock this call.
 */
export async function claimPendingResponses(
  db: DbOrTx,
  args: { now: Date; batchSize: number; maxRetries: number },
): Promise<PendingResponseRow[]> {
  const result = await db.execute(sql`
    SELECT id,
           project_id              AS "projectId",
           subscriber_id           AS "subscriberId",
           apple_notification_uuid AS "appleNotificationUuid",
           apple_original_transaction_id AS "appleOriginalTransactionId",
           apple_transaction_id    AS "appleTransactionId",
           detected_at             AS "detectedAt",
           scheduled_for           AS "scheduledFor",
           status,
           retry_count             AS "retryCount",
           apple_environment       AS "appleEnvironment"
    FROM ${refundShieldResponses}
    WHERE status = 'PENDING'
      AND scheduled_for <= ${args.now}
      AND retry_count < ${args.maxRetries}
    ORDER BY scheduled_for ASC
    LIMIT ${args.batchSize}
    FOR UPDATE SKIP LOCKED
  `);
  // `db.execute(sql`…`)` bypasses Drizzle's column mapper, so timestamp
  // columns arrive as ISO strings from node-postgres. Coerce to `Date`
  // here so downstream code (worker SLA math, audit emission) can call
  // `.getTime()` without re-checking the row's shape.
  const rows =
    (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  return rows.map((row) => ({
    id: row.id as string,
    projectId: row.projectId as string,
    subscriberId: (row.subscriberId as string | null) ?? null,
    appleNotificationUuid: row.appleNotificationUuid as string,
    appleOriginalTransactionId: row.appleOriginalTransactionId as string,
    appleTransactionId: row.appleTransactionId as string,
    detectedAt:
      row.detectedAt instanceof Date
        ? row.detectedAt
        : new Date(row.detectedAt as string),
    scheduledFor:
      row.scheduledFor instanceof Date
        ? row.scheduledFor
        : new Date(row.scheduledFor as string),
    status: row.status as string,
    retryCount: Number(row.retryCount),
    appleEnvironment: row.appleEnvironment as RefundShieldAppleEnvironment,
  }));
}

export interface MarkSentInput {
  id: string;
  requestPayload: unknown;
  appleHttpStatus: number;
  sentAt: Date;
}

export async function markResponseSent(
  db: DbOrTx,
  input: MarkSentInput,
): Promise<void> {
  await db
    .update(refundShieldResponses)
    .set({
      status: "SENT",
      sentAt: input.sentAt,
      requestPayload:
        input.requestPayload as typeof refundShieldResponses.$inferInsert.requestPayload,
      appleHttpStatus: input.appleHttpStatus,
      error: null,
      updatedAt: input.sentAt,
    })
    .where(eq(refundShieldResponses.id, input.id));
}

export interface MarkRetryInput {
  id: string;
  retryCount: number;
  scheduledFor: Date;
  error: string;
  updatedAt: Date;
}

export async function markResponseRetry(
  db: DbOrTx,
  input: MarkRetryInput,
): Promise<void> {
  await db
    .update(refundShieldResponses)
    .set({
      retryCount: input.retryCount,
      scheduledFor: input.scheduledFor,
      error: input.error,
      updatedAt: input.updatedAt,
    })
    .where(eq(refundShieldResponses.id, input.id));
}

export interface MarkFailedInput {
  id: string;
  error: string;
  appleHttpStatus?: number | null;
  appleResponseBody?: string | null;
  updatedAt: Date;
}

export async function markResponseFailed(
  db: DbOrTx,
  input: MarkFailedInput,
): Promise<void> {
  await db
    .update(refundShieldResponses)
    .set({
      status: "FAILED",
      error: input.error,
      appleHttpStatus: input.appleHttpStatus ?? null,
      appleResponseBody: input.appleResponseBody ?? null,
      updatedAt: input.updatedAt,
    })
    .where(eq(refundShieldResponses.id, input.id));
}

export interface MarkSkippedInput {
  id: string;
  status: "SKIPPED_DISABLED" | "SKIPPED_NOT_FOUND";
  error?: string | null;
  updatedAt: Date;
}

export async function markResponseSkipped(
  db: DbOrTx,
  input: MarkSkippedInput,
): Promise<void> {
  await db
    .update(refundShieldResponses)
    .set({
      status: input.status,
      error: input.error ?? null,
      updatedAt: input.updatedAt,
    })
    .where(eq(refundShieldResponses.id, input.id));
}
