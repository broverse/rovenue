// =============================================================
// integrations-boot.ts — M2.6
// =============================================================
//
// Wires together:
//   1. The integrations-deliver BullMQ worker (M2.5)
//   2. The integrations fanout Kafka consumer (M2.3)
//   3. A connection cache backed by Postgres (M2.2)
//
// The `autoStart: false` path returns a no-op handle immediately
// without touching Redis or Postgres, which keeps unit tests fast.

import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { getDb, drizzle } from "@rovenue/db";
import { env } from "./lib/env";
import { attachRedisErrorLogger } from "./lib/redis";
import { startIntegrationsFanout } from "./services/integrations-fanout/consumer";
import { createConnectionCache } from "./services/integrations-fanout/connection-cache";
import { fanoutTopics } from "./services/integrations/registry";
import { ensureIntegrationsDeliverWorker } from "./workers/integrations-deliver";
import { assertTopics } from "./workers/outbox-dispatcher";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  buildIntegrationsDeliverJobId,
  deliverJobOptions,
  type IntegrationsDeliverJob,
} from "./queues/integrations";

export interface IntegrationsBootHandle {
  stop: () => Promise<void>;
}

export async function bootIntegrations(
  opts: { autoStart?: boolean } = {},
): Promise<IntegrationsBootHandle> {
  if (opts.autoStart === false) {
    return { stop: async () => {} };
  }

  const workerHandle = await ensureIntegrationsDeliverWorker({ autoStart: true });

  const connection = attachRedisErrorLogger(
    new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
    "integrations-boot-queue",
  );

  const queue = new Queue<IntegrationsDeliverJob>(
    INTEGRATIONS_DELIVER_QUEUE_NAME,
    { connection },
  );

  const db = getDb();
  const { integrationConnectionRepo } = drizzle;

  const cache = createConnectionCache({
    ttlMs: 60_000,
    loader: (projectId) =>
      integrationConnectionRepo.listActiveConnectionsForProject(db, projectId),
  });

  // Provision the topics the fan-out subscribes to. Only the outbox
  // dispatcher used to assert topics, so on a cluster where the dispatcher
  // hadn't run yet (Redpanda ships with auto-create off) the consumer
  // joined a group on topics that didn't exist. Reuses the dispatcher's own
  // helper — no-op when KAFKA_BROKERS is unset.
  await assertTopics(fanoutTopics());

  const fanout = await startIntegrationsFanout({
    cache,
    enqueue: async (job: IntegrationsDeliverJob, jobId: string) => {
      await queue.add("deliver", job, deliverJobOptions(job.providerId, jobId));
    },
  });

  return {
    stop: async () => {
      await fanout.stop();
      await workerHandle.stop();
      await queue.close();
      await connection.quit();
    },
  };
}
