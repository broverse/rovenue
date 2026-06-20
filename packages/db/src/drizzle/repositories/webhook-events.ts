import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../client";
import { webhookEvents, type WebhookEvent } from "../schema";
import { webhookEventStatus, webhookSource } from "../enums";

type DbOrTx = Db;
type WebhookSource = (typeof webhookSource.enumValues)[number];
type WebhookEventStatus = (typeof webhookEventStatus.enumValues)[number];

/** Idempotency lookup by (source, storeEventId) unique index. */
export async function findWebhookEventByStoreId(
  db: Db,
  source: "APPLE" | "GOOGLE" | "STRIPE",
  storeEventId: string,
): Promise<WebhookEvent | null> {
  const rows = await db
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.source, source),
        eq(webhookEvents.storeEventId, storeEventId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** By primary id — used by the worker processor to hydrate the
 *  enqueued job payload after claiming it from the queue. */
export async function findWebhookEventById(
  db: Db,
  id: string,
): Promise<WebhookEvent | null> {
  const rows = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// =============================================================
// Webhook event reads — Drizzle repository
// =============================================================

export async function findLastProcessedWebhookAt(
  db: Db,
  projectId: string,
  source: WebhookSource,
): Promise<Date | null> {
  const rows = await db
    .select({ processedAt: webhookEvents.processedAt })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.projectId, projectId),
        eq(webhookEvents.source, source),
        eq(webhookEvents.status, "PROCESSED"),
      ),
    )
    .orderBy(desc(webhookEvents.processedAt))
    .limit(1);
  return rows[0]?.processedAt ?? null;
}

// =============================================================
// Writes
// =============================================================

export interface UpsertWebhookEventInput {
  projectId: string;
  source: WebhookSource;
  eventType: string;
  storeEventId: string;
  payload: unknown;
  status: WebhookEventStatus;
}

/**
 * Idempotent insert keyed on (source, storeEventId). On conflict
 * the existing row is returned unmodified — callers inspect the
 * returned `status` to decide whether to skip (PROCESSED) or
 * continue claiming the event.
 */
export async function upsertWebhookEvent(
  db: DbOrTx,
  input: UpsertWebhookEventInput,
): Promise<WebhookEvent> {
  const rows = await db
    .insert(webhookEvents)
    .values({
      projectId: input.projectId,
      source: input.source,
      eventType: input.eventType,
      storeEventId: input.storeEventId,
      payload: input.payload as typeof webhookEvents.$inferInsert.payload,
      status: input.status,
    })
    .onConflictDoUpdate({
      target: [webhookEvents.source, webhookEvents.storeEventId],
      // Setting source back to itself is a no-op that still lets
      // .returning() return the conflict-losing row.
      set: { source: input.source },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("upsertWebhookEvent: no row returned");
  return row;
}

export interface ClaimWebhookEventInput {
  projectId: string;
  source: WebhookSource;
  eventType: string;
  storeEventId: string;
  payload: unknown;
}

// Mirrors outgoing-webhooks CLAIM_LEASE_MS. A PROCESSING row whose
// claimedAt predates this window is assumed orphaned (the worker that
// claimed it crashed) and is re-claimable. Must exceed the slowest
// realistic handler run (store API verify + dispatch) by a wide margin.
const WEBHOOK_CLAIM_LEASE_MS = 5 * 60_000;

export type ClaimResult =
  | { outcome: "claimed"; row: WebhookEvent }
  | { outcome: "duplicate" }
  | { outcome: "in_progress" };

/**
 * Atomically claim a webhook event for processing with a lease timestamp.
 *
 * - Fresh insert → PROCESSING + claimedAt = now → { outcome: "claimed" }
 * - Conflict on (source, storeEventId):
 *   - If existing row is PROCESSED → { outcome: "duplicate" }
 *   - If existing row is PROCESSING but claimedAt is past the lease
 *     (orphaned worker) → update to PROCESSING + claimedAt = now → { outcome: "claimed" }
 *   - If existing row is PROCESSING and claimedAt is fresh → { outcome: "in_progress" }
 *
 * The setWhere clause fires only when the row is either not yet claimed
 * (RECEIVED/FAILED) OR the PROCESSING lease has expired. If setWhere is
 * false, no row is returned — we then do a follow-up read to distinguish
 * PROCESSED (safe to skip) from fresh PROCESSING (caller must retry).
 */
export async function claimWebhookEvent(
  db: DbOrTx,
  input: ClaimWebhookEventInput,
  now: Date = new Date(),
): Promise<ClaimResult> {
  const leaseCutoff = new Date(now.getTime() - WEBHOOK_CLAIM_LEASE_MS);
  const rows = await db
    .insert(webhookEvents)
    .values({
      projectId: input.projectId,
      source: input.source,
      eventType: input.eventType,
      storeEventId: input.storeEventId,
      payload: input.payload as typeof webhookEvents.$inferInsert.payload,
      status: "PROCESSING",
      claimedAt: now,
    })
    .onConflictDoUpdate({
      target: [webhookEvents.source, webhookEvents.storeEventId],
      set: { status: "PROCESSING", claimedAt: now },
      // Claim if NOT already done, AND either not currently being worked
      // or the in-flight claim has expired (orphaned worker).
      setWhere: sql`${webhookEvents.status} <> 'PROCESSED'
        AND (${webhookEvents.status} <> 'PROCESSING'
             OR ${webhookEvents.claimedAt} < ${leaseCutoff})`,
    })
    .returning();
  if (rows[0]) return { outcome: "claimed", row: rows[0] };
  // No row returned → the setWhere was false. Distinguish PROCESSED
  // (truly done — safe to skip) from fresh PROCESSING (someone else is
  // actively working it — the caller must retry, not ack).
  const existing = await findWebhookEventByStoreId(
    db as Db,
    input.source as "APPLE" | "GOOGLE" | "STRIPE",
    input.storeEventId,
  );
  if (existing?.status === "PROCESSED") return { outcome: "duplicate" };
  return { outcome: "in_progress" };
}

/**
 * Reset orphaned PROCESSING rows (claimedAt past the lease) back to
 * FAILED so they become re-claimable and visible to alerting. Returns
 * the count reclaimed. Called at the top of the reaper tick.
 */
export async function reclaimStaleWebhookEvents(
  db: DbOrTx,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - WEBHOOK_CLAIM_LEASE_MS);
  const result = await db.execute(sql`
    UPDATE ${webhookEvents}
    SET status = 'FAILED',
        "errorMessage" = 'reclaimed: orphaned PROCESSING past lease',
        "retryCount" = "retryCount" + 1
    WHERE status = 'PROCESSING' AND "claimedAt" < ${cutoff}
  `);
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

export interface UpdateWebhookEventInput {
  status?: WebhookEventStatus;
  processedAt?: Date | null;
  errorMessage?: string | null;
  subscriberId?: string | null;
  purchaseId?: string | null;
  incrementRetryCount?: boolean;
}

/**
 * Partial update for the processor's state transitions
 * (PROCESSING → PROCESSED | FAILED). `incrementRetryCount` uses
 * a SQL expression so concurrent workers can't clobber each
 * other's increments.
 */
export async function updateWebhookEvent(
  db: DbOrTx,
  id: string,
  patch: UpdateWebhookEventInput,
): Promise<void> {
  const data: Partial<typeof webhookEvents.$inferInsert> = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.processedAt !== undefined) data.processedAt = patch.processedAt;
  if (patch.errorMessage !== undefined) data.errorMessage = patch.errorMessage;
  if (patch.subscriberId !== undefined) data.subscriberId = patch.subscriberId;
  if (patch.purchaseId !== undefined) data.purchaseId = patch.purchaseId;
  if (patch.incrementRetryCount) {
    data.retryCount = sql`${webhookEvents.retryCount} + 1` as unknown as number;
  }
  if (Object.keys(data).length === 0) return;
  await db
    .update(webhookEvents)
    .set(data)
    .where(eq(webhookEvents.id, id));
}

/**
 * Bulk-delete webhook_events rows older than the retention cutoff.
 * Used by the nightly webhook-retention BullMQ job. Returns the
 * total count of rows removed.
 *
 * Batched: deletes at most `batchSize` rows per iteration (bounded
 * subselect), loops until a batch is partial, and caps at
 * `maxBatches` iterations as a safety brake. This avoids a single
 * long table-wide lock, WAL spike, or OOM from a large `.returning()`.
 *
 * Mirrors the outbox-cleanup worker's `deletePublishedOlderThan`
 * pattern (see packages/db/src/drizzle/repositories/outbox.ts).
 *
 * Rationale: webhook_events is not a hypertable (the UNIQUE
 * (source, storeEventId) key is load-bearing for the upsert
 * dedup contract — see upsertWebhookEvent above). Retention is
 * handled at the application layer via this DELETE instead of a
 * TimescaleDB drop_chunks policy.
 */
export async function deleteWebhookEventsOlderThan(
  db: DbOrTx,
  cutoff: Date,
  batchSize = 10_000,
  maxBatches = 1_000,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await db.execute(sql`
      DELETE FROM ${webhookEvents}
      WHERE id IN (
        SELECT id FROM ${webhookEvents}
        WHERE "createdAt" < ${cutoff}
        ORDER BY "createdAt" ASC
        LIMIT ${batchSize}
      )
    `);
    // node-postgres returns rowCount on Result; drizzle's execute
    // returns the underlying QueryResult. Both expose `rowCount`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = (result as any)?.rowCount ?? 0;
    total += Number(n);
    if (Number(n) < batchSize) break;
  }
  return total;
}

/** Count webhook events processed in a billing period (for usage metering). */
export async function countWebhookEventsInPeriod(
  db: Db,
  projectId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.projectId, projectId),
        gte(webhookEvents.createdAt, periodStart),
        lt(webhookEvents.createdAt, periodEnd),
      ),
    );
  return Number(row?.value ?? 0);
}
