// =============================================================
// Funnel deferred-claim cleanup background worker
// =============================================================
//
// Every 5 minutes, deletes funnel_deferred_claims rows whose
// `expires_at` is in the past. The deferred-claim window is
// short (24h) because the iOS fingerprint match has to happen
// shortly after install or the entropy decays. Pruning
// aggressively keeps the candidate set returned by
// findRecentByIpHash tight, which matters because the SDK
// scans every candidate per claim attempt.

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

const log = logger.child("funnel-deferred-cleanup");

export const FUNNEL_DEFERRED_CLEANUP_QUEUE_NAME =
  "rovenue-funnel-deferred-cleanup";

const REPEAT_CRON = "*/5 * * * *"; // every 5 minutes
const REPEATABLE_JOB_NAME = "funnel-deferred-cleanup:sweep";
const REPEATABLE_JOB_ID = "funnel-deferred-cleanup-repeatable";

// =============================================================
// Job body
// =============================================================

export async function runFunnelDeferredCleanupSweep(
  now: Date = new Date(),
): Promise<{ deleted: number }> {
  const deleted = await drizzle.funnelDeferredClaimRepo.deleteExpired(
    drizzle.db,
    now,
  );
  log.info("expired funnel deferred claims removed", { deleted });
  return { deleted };
}

// =============================================================
// BullMQ queue + worker + scheduling
// =============================================================

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

let cachedQueue: Queue | undefined;

export function getFunnelDeferredCleanupQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(FUNNEL_DEFERRED_CLEANUP_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleFunnelDeferredCleanup(): Promise<void> {
  const queue = getFunnelDeferredCleanupQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { pattern: REPEAT_CRON },
    },
  );
  log.info("scheduled funnel deferred cleanup", { pattern: REPEAT_CRON });
}

let cachedWorker: Worker | undefined;

export function createFunnelDeferredCleanupWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    FUNNEL_DEFERRED_CLEANUP_QUEUE_NAME,
    async (_job: Job) => {
      return runFunnelDeferredCleanupSweep();
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("funnel deferred cleanup job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("funnel deferred cleanup job completed", { jobId: job.id });
  });

  log.info("funnel deferred cleanup worker started", {
    queue: FUNNEL_DEFERRED_CLEANUP_QUEUE_NAME,
  });
  return cachedWorker;
}
