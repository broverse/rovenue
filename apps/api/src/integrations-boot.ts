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
import { startIntegrationsFanout } from "./services/integrations-fanout/consumer";
import { createConnectionCache } from "./services/integrations-fanout/connection-cache";
import { ensureIntegrationsDeliverWorker } from "./workers/integrations-deliver";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  buildIntegrationsDeliverJobId,
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

  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

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

  const fanout = await startIntegrationsFanout({
    cache,
    enqueue: async (job: IntegrationsDeliverJob, jobId: string) => {
      await queue.add("deliver", job, {
        jobId,
        attempts: 5,
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 7 * 86_400 },
      });
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
