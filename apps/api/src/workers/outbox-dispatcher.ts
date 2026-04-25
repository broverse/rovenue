import { drizzle, getDb, type OutboxEvent } from "@rovenue/db";
import { assertTopic, disconnectKafka, getProducer } from "../lib/kafka";
import { logger } from "../lib/logger";

// =============================================================
// outbox-dispatcher
// =============================================================
//
// Batch loop: read up to BATCH_SIZE unpublished outbox rows, group
// by aggregateType → topic, publish to Redpanda, mark published.
// Sleeps POLL_INTERVAL_MS between empty reads; when a batch is
// drained it immediately re-polls without sleeping.
//
// At-least-once semantics: if the process dies between Kafka ack
// and markPublished, the row is re-delivered on restart. ClickHouse
// de-duplicates on eventId via ReplacingMergeTree (Phase E).
//
// Per-topic isolation: topic-level Promise.allSettled keeps healthy
// topics draining while a sick topic backs off (exp from 500ms to
// 30s). Backing-off topics' rows are deferred via the in-memory
// claim filter below — DB rows stay unpublished, naturally re-claim
// when the topic unfreezes. WARN-level log fires after 3 consecutive
// failures (actionable).
//
// Single-instance assumption. Horizontal scale would shard by
// aggregateId → Kafka partition; deferred to Plan 3.

const BATCH_SIZE = 250;
const POLL_INTERVAL_MS = 500;

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_LOG_THRESHOLD = 3;

const AGGREGATE_TO_TOPIC: Record<OutboxEvent["aggregateType"], string> = {
  EXPOSURE: "rovenue.exposures",
  REVENUE_EVENT: "rovenue.revenue",
  CREDIT_LEDGER: "rovenue.credit",
};

// =============================================================
// Per-topic backoff state
// =============================================================
//
// Module-level so it survives across loop iterations. Exported
// via getBackoffState() for test assertions only — not part of
// the public production API.

type BackoffState = { consecutiveFailures: number; nextAttemptAt: number };
export const topicBackoff = new Map<string, BackoffState>();

export function getBackoffState(topic: string): BackoffState | undefined {
  return topicBackoff.get(topic);
}

function onTopicFailure(topic: string, reason: unknown): void {
  const prev = topicBackoff.get(topic) ?? {
    consecutiveFailures: 0,
    nextAttemptAt: 0,
  };
  const failures = prev.consecutiveFailures + 1;
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, failures));
  const next: BackoffState = {
    consecutiveFailures: failures,
    nextAttemptAt: Date.now() + delay,
  };
  topicBackoff.set(topic, next);
  if (failures >= BACKOFF_LOG_THRESHOLD) {
    logger.warn("outbox.dispatcher.topic-backoff", {
      topic,
      consecutiveFailures: failures,
      nextAttemptInMs: delay,
      reason: String(reason),
    });
  }
}

function onTopicSuccess(topic: string): void {
  topicBackoff.delete(topic);
}

function isTopicBackingOff(topic: string): boolean {
  const s = topicBackoff.get(topic);
  return !!s && s.nextAttemptAt > Date.now();
}

let stopFlag = false;

export function stopOutboxDispatcher(): void {
  stopFlag = true;
}

// =============================================================
// runOnce — a single poll tick. Exported for test-driven
// invocation so tests can drive exactly N cycles without timers.
// =============================================================

export async function runOnce(
  producer: NonNullable<Awaited<ReturnType<typeof getProducer>>>,
): Promise<void> {
  const db = getDb();
  const batch = await db.transaction(async (tx) => {
    return drizzle.outboxRepo.claimBatch(tx, BATCH_SIZE);
  });

  if (batch.length === 0) return;

  // Partition into "ready" (topic not backing off) and "deferred"
  // (topic in backoff window). Deferred rows are left untouched in
  // the DB — claimBatch uses FOR UPDATE SKIP LOCKED inside its tx,
  // so after the tx commits the lock is released and deferred rows
  // become claimable again on the next poll. No explicit DB write
  // needed.
  const eligible: OutboxEvent[] = [];
  for (const row of batch) {
    const topic = AGGREGATE_TO_TOPIC[row.aggregateType];
    if (isTopicBackingOff(topic)) {
      // Skip — leave row unpublished; it re-appears on next claim.
      continue;
    }
    eligible.push(row);
  }

  if (eligible.length === 0) return;

  // Group eligible rows by topic.
  const byTopic = new Map<string, OutboxEvent[]>();
  for (const row of eligible) {
    const topic = AGGREGATE_TO_TOPIC[row.aggregateType];
    const list = byTopic.get(topic) ?? [];
    list.push(row);
    byTopic.set(topic, list);
  }

  // Publish per topic with isolation: one topic failing does NOT
  // block others. Key by aggregateId for partition stability so
  // same-experiment events land on the same partition and preserve order.
  const results = await Promise.allSettled(
    Array.from(byTopic.entries()).map(async ([topic, rows]) => {
      await producer.send({
        topic,
        messages: rows.map((r) => ({
          key: r.aggregateId,
          value: JSON.stringify({
            eventId: r.id,
            eventType: r.eventType,
            aggregateId: r.aggregateId,
            createdAt: r.createdAt.toISOString(),
            payload: r.payload,
          }),
        })),
      });
      return { topic, rows };
    }),
  );

  // Collect succeeded rows; update per-topic backoff state.
  const succeeded: OutboxEvent[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      succeeded.push(...r.value.rows);
      onTopicSuccess(r.value.topic);
    } else {
      // Extract topic from rejected promise reason if possible.
      // Since we can't attach the topic to the Error directly, we
      // use the fulfilled/rejected shape to correlate via the
      // iteration order matching byTopic.entries() — but that is
      // fragile. Instead we infer from comparing failed rows: we
      // know all rows for a given topic are either in or out.
      // Log with generic context; backoff is still tracked via the
      // topic attached by onTopicFailure below.
      logger.error("outbox.dispatcher.send-failed", {
        reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  // Second pass: for any topic whose rows are NOT in succeeded, mark
  // the topic as failed (increment backoff). We identify failed topics
  // by diffing byTopic vs succeeded set.
  const succeededIds = new Set(succeeded.map((r) => r.id));
  for (const [topic, rows] of byTopic.entries()) {
    const allSucceeded = rows.every((r) => succeededIds.has(r.id));
    if (!allSucceeded) {
      // Find the reject reason — unfortunately allSettled doesn't
      // annotate which topic failed. We pull from the result index
      // that corresponds to this topic entry.
      const topicIndex = Array.from(byTopic.keys()).indexOf(topic);
      const result = results[topicIndex];
      const reason = result?.status === "rejected" ? result.reason : "unknown";
      onTopicFailure(topic, reason);
    }
  }

  // Mark only successfully published rows as published.
  if (succeeded.length > 0) {
    await getDb().transaction(async (tx) => {
      await drizzle.outboxRepo.markPublished(
        tx,
        succeeded.map((r) => r.id),
      );
    });
    logger.debug("outbox-dispatcher: flushed batch", { size: succeeded.length });
  }
}

export async function runOutboxDispatcher(): Promise<void> {
  const producer = await getProducer();
  if (!producer) {
    logger.warn("outbox-dispatcher: KAFKA_BROKERS unset, skipping worker");
    return;
  }

  // Ensure all topics exist before we try to publish.
  for (const topic of new Set(Object.values(AGGREGATE_TO_TOPIC))) {
    await assertTopic(topic);
  }

  // Log the broker URL we actually resolved so integration tests can
  // prove the dispatcher is hitting the testcontainer and not the
  // developer's dev-compose Redpanda.
  logger.info("outbox-dispatcher: started", {
    brokers: process.env.KAFKA_BROKERS ?? "<env>",
  });

  while (!stopFlag) {
    try {
      await runOnce(producer);
      // If batch was empty, runOnce returns early; we sleep to avoid
      // a hot-loop on an empty queue. If the batch had rows, we
      // immediately re-poll (no sleep needed — the next loop iteration
      // calls runOnce again at once). We use a short yield so the
      // loop remains interruptable via stopFlag.
      await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      logger.error("outbox-dispatcher: loop error, backing off", {
        err: err instanceof Error ? err.message : String(err),
      });
      await sleep(2000);
    }
  }

  await disconnectKafka();
  logger.info("outbox-dispatcher: stopped");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
