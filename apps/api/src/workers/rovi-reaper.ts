// =============================================================
// Rovi Reaper — stale copilot-intent expiry worker
// =============================================================
//
// Per-minute BullMQ repeatable job that flips copilot_intents
// rows whose `expires_at` is in the past (status = 'pending')
// to 'expired'. Prevents the intents table from accumulating
// zombie rows that were never acted upon.

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

const log = logger.child("rovi-reaper");

export const ROVI_REAPER_QUEUE_NAME = "rovenue-rovi-reaper";

const REPEATABLE_JOB_NAME = "rovi-reaper:sweep";
const REPEATABLE_JOB_ID = "rovi-reaper-repeatable";

// =============================================================
// Job body
// =============================================================

export async function reapStaleIntents(): Promise<number> {
  const expired = await drizzle.copilotIntentRepo.expireStaleIntents(drizzle.db);
  log.info("reaped stale copilot intents", { expired });
  return expired;
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

export function getRoviReaperQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(ROVI_REAPER_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleRoviReaper(): Promise<void> {
  const queue = getRoviReaperQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: 60_000 },
    },
  );
  log.info("scheduled rovi reaper", { every: "60s" });
}

let cachedWorker: Worker | undefined;

export function createRoviReaperWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    ROVI_REAPER_QUEUE_NAME,
    async (_job: Job) => {
      const expired = await reapStaleIntents();
      return { expired };
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("rovi reaper job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job, result: { expired: number }) => {
    log.debug("rovi reaper job completed", {
      jobId: job.id,
      expired: result.expired,
    });
  });

  log.info("rovi reaper worker started", { queue: ROVI_REAPER_QUEUE_NAME });
  return cachedWorker;
}
