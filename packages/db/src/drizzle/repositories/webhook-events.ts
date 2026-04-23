import { and, desc, eq, lt, sql } from "drizzle-orm";
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
  source: "APPLE" | "GOOGLE" | "STRIPE",
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
 * count of rows removed.
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
): Promise<number> {
  const result = await db
    .delete(webhookEvents)
    .where(lt(webhookEvents.createdAt, cutoff))
    .returning({ id: webhookEvents.id });
  return result.length;
}
