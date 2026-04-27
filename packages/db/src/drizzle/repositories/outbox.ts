import { and, asc, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  outboxEvents,
  type NewOutboxEvent,
  type OutboxEvent,
} from "../schema";

// =============================================================
// outbox repository
// =============================================================
//
// insert — called by event-bus.publishExposure inside the caller's
// transaction. The caller passes a tx-bound Db; this repo never
// opens its own transaction.
//
// claimBatch — reads up to `limit` unpublished rows ordered by
// createdAt. Uses SELECT ... FOR UPDATE SKIP LOCKED so multiple
// dispatcher instances can run without trampling each other (Plan 1
// is single-instance; SKIP LOCKED is future-proofing).
//
// markPublished — flips publishedAt = NOW() for a batch of ids,
// called after Kafka ack.
//
// countUnpublished — used by health checks and the verify-clickhouse
// CLI to flag stuck dispatch queues.

export async function insert(
  db: Db,
  row: NewOutboxEvent,
): Promise<void> {
  await db.insert(outboxEvents).values(row);
}

export async function claimBatch(
  db: Db,
  limit: number,
): Promise<OutboxEvent[]> {
  // FOR UPDATE SKIP LOCKED on the unpublished partial index.
  // Drizzle's .for() is not typed for SKIP LOCKED in 0.45, so we
  // drop to a raw SQL fragment in the final clause.
  return db
    .select()
    .from(outboxEvents)
    .where(isNull(outboxEvents.publishedAt))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(limit)
    .for("update", { skipLocked: true });
}

export async function markPublished(
  db: Db,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(outboxEvents)
    .set({ publishedAt: sql`NOW()` })
    .where(and(inArray(outboxEvents.id, ids), isNull(outboxEvents.publishedAt)));
}

export async function countUnpublished(db: Db): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(outboxEvents)
    .where(isNull(outboxEvents.publishedAt));
  return Number(result[0]?.count ?? 0);
}

/**
 * Deletes up to `batchSize` rows whose `publishedAt` is set and is
 * older than `cutoff`. Returns the number of rows actually deleted —
 * caller loops until 0 to drain. Used by the outbox-cleanup worker
 * (Plan 3 §F.2). The outbox is fan-out, not a journal: 24h is
 * enough headroom for replay; longer-window replays come from the
 * authoritative `revenue_events` / `credit_ledger` tables.
 */
export async function deletePublishedOlderThan(
  db: Db,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM ${outboxEvents}
     WHERE id IN (
       SELECT id FROM ${outboxEvents}
        WHERE ${outboxEvents.publishedAt} IS NOT NULL
          AND ${outboxEvents.publishedAt} < ${cutoff}
        ORDER BY ${outboxEvents.publishedAt} ASC
        LIMIT ${batchSize}
     )
  `);
  // node-postgres returns rowCount on Result; drizzle's execute
  // returns the underlying QueryResult. Both expose `rowCount`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowCount = (result as any)?.rowCount ?? 0;
  return Number(rowCount);
}

export type { OutboxEvent, NewOutboxEvent };
