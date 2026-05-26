// =============================================================
// Funnel session abandoner background worker
// =============================================================
//
// Hourly BullMQ repeatable job that flips funnel sessions in the
// `in_progress` state to `abandoned` once their lastActivityAt is
// older than 24 hours. The state column powers downstream
// reporting (completion rate, abandonment funnel) and lets the
// claim-token expirer reason about which sessions are still in
// flight.

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

const log = logger.child("funnel-abandoner");

export const FUNNEL_ABANDONER_QUEUE_NAME = "rovenue-funnel-abandoner";

const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;
const REPEAT_CRON = "0 * * * *"; // hourly, on the hour
const REPEATABLE_JOB_NAME = "funnel-abandoner:sweep";
const REPEATABLE_JOB_ID = "funnel-abandoner-repeatable";

// =============================================================
// Job body
// =============================================================

export async function runFunnelAbandonerSweep(
  now: Date = new Date(),
): Promise<{ updated: number }> {
  const cutoff = new Date(now.getTime() - ABANDON_AFTER_MS);
  const updated = await drizzle.funnelSessionRepo.markAbandonedOlderThan(
    drizzle.db,
    cutoff,
  );
  log.info("marked funnel sessions abandoned", { updated });
  return { updated };
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

export function getFunnelAbandonerQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(FUNNEL_ABANDONER_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Register the hourly repeatable job. Safe to call multiple times
 * on boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function scheduleFunnelAbandoner(): Promise<void> {
  const queue = getFunnelAbandonerQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { pattern: REPEAT_CRON },
    },
  );
  log.info("scheduled funnel abandoner", { pattern: REPEAT_CRON });
}

let cachedWorker: Worker | undefined;

export function createFunnelAbandonerWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    FUNNEL_ABANDONER_QUEUE_NAME,
    async (_job: Job) => {
      return runFunnelAbandonerSweep();
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("funnel abandoner job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("funnel abandoner job completed", { jobId: job.id });
  });

  log.info("funnel abandoner worker started", {
    queue: FUNNEL_ABANDONER_QUEUE_NAME,
  });
  return cachedWorker;
}
