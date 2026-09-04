// =============================================================
// renewal-grants-boot.ts
// =============================================================
//
// Wires together:
//   1. The renewal-grant BullMQ worker (Task 3)
//   2. The renewal-grants Kafka consumer on rovenue.revenue (Task 4),
//      a SECOND, independent consumer group beside
//      rovenue-integrations-fanout.
//
// The `autoStart: false` path returns a no-op handle immediately
// without touching Redis or Kafka, which keeps unit tests fast.
// Mirrors integrations-boot.ts.

import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./lib/env";
import { attachRedisErrorLogger } from "./lib/redis";
import { startRenewalGrantConsumer } from "./services/renewal-grants/consumer";
import { ensureRenewalGrantWorker } from "./workers/renewal-grant";
import { assertTopics } from "./workers/outbox-dispatcher";
import { AGGREGATE_TO_TOPIC } from "./lib/outbox-topics";
import {
  RENEWAL_GRANT_QUEUE_NAME,
  renewalGrantJobOptions,
  type RenewalGrantJob,
} from "./queues/renewal-grants";

export interface RenewalGrantsBootHandle {
  stop: () => Promise<void>;
}

export async function bootRenewalGrants(
  opts: { autoStart?: boolean } = {},
): Promise<RenewalGrantsBootHandle> {
  if (opts.autoStart === false) return { stop: async () => {} };

  const workerHandle = await ensureRenewalGrantWorker({ autoStart: true });

  const connection = attachRedisErrorLogger(
    new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
    "renewal-grants-boot-queue",
  );

  const queue = new Queue<RenewalGrantJob>(RENEWAL_GRANT_QUEUE_NAME, {
    connection,
  });

  // Provision the topic the consumer subscribes to. No-op when
  // KAFKA_BROKERS is unset. Reuses the dispatcher's own helper — same
  // reasoning as integrations-boot.ts: on a cluster where the dispatcher
  // hasn't run yet, Redpanda ships with auto-create off.
  await assertTopics([AGGREGATE_TO_TOPIC.REVENUE_EVENT]);

  const consumer = await startRenewalGrantConsumer({
    enqueue: async (job, jobId) => {
      await queue.add("grant", job, renewalGrantJobOptions(jobId));
    },
  });

  return {
    stop: async () => {
      await consumer.stop();
      await workerHandle.stop();
      await queue.close();
      await connection.quit();
    },
  };
}
