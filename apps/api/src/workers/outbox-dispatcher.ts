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
// Single-instance assumption. Horizontal scale would shard by
// aggregateId → Kafka partition; deferred to Plan 3.

const BATCH_SIZE = 250;
const POLL_INTERVAL_MS = 500;

const AGGREGATE_TO_TOPIC: Record<OutboxEvent["aggregateType"], string> = {
  EXPOSURE: "rovenue.exposures",
  REVENUE_EVENT: "rovenue.revenue",
  CREDIT_LEDGER: "rovenue.credit",
};

let stopFlag = false;

export function stopOutboxDispatcher(): void {
  stopFlag = true;
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
      const db = getDb();
      const batch = await db.transaction(async (tx) => {
        return drizzle.outboxRepo.claimBatch(tx, BATCH_SIZE);
      });

      if (batch.length === 0) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Group by topic.
      const byTopic = new Map<string, typeof batch>();
      for (const row of batch) {
        const topic = AGGREGATE_TO_TOPIC[row.aggregateType];
        const list = byTopic.get(topic) ?? [];
        list.push(row);
        byTopic.set(topic, list);
      }

      // Publish per topic in one send call (kafkajs batches under
      // the hood). Key by aggregateId for partition stability so
      // same-experiment events land on the same partition and
      // preserve order.
      const publishResults = await Promise.all(
        Array.from(byTopic.entries()).map(([topic, rows]) =>
          producer.send({
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
          }),
        ),
      );

      // If all sends succeeded, mark the whole batch published.
      const acked = publishResults.every((r) => r.length > 0);
      if (acked) {
        await getDb().transaction(async (tx) => {
          await drizzle.outboxRepo.markPublished(
            tx,
            batch.map((r) => r.id),
          );
        });
        logger.debug("outbox-dispatcher: flushed batch", { size: batch.length });
      } else {
        logger.warn(
          "outbox-dispatcher: partial publish — skipping markPublished, will retry next poll",
        );
      }
    } catch (err) {
      // TODO(plan-phase-G): per-topic isolation + exponential backoff.
      // Today a single permanently-broken topic (or bad payload) causes
      // the whole batch to re-fetch every 500ms forever. Switch to
      // Promise.allSettled + per-topic failure tracking so healthy
      // topics keep draining while the sick one backs off.
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
