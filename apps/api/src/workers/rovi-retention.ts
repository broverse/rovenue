// =============================================================
// Rovi Retention — daily GDPR message deletion worker
// =============================================================
//
// Daily BullMQ repeatable job (03:00 UTC) that hard-deletes
// copilot_messages rows older than ROVI_MESSAGE_RETENTION_DAYS.
// Satisfies GDPR Art. 5(1)(e) storage-limitation obligation.

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

const log = logger.child("rovi-retention");

export const ROVI_RETENTION_QUEUE_NAME = "rovenue-rovi-retention";

const REPEATABLE_JOB_NAME = "rovi-retention:purge";
const REPEATABLE_JOB_ID = "rovi-retention-repeatable";

// =============================================================
// Job body
// =============================================================

export async function purgeOldMessages(): Promise<number> {
  const days = env.ROVI_MESSAGE_RETENTION_DAYS;
  const deleted = await drizzle.copilotMessageRepo.purgeOldMessages(drizzle.db, days);
  log.info("purged old copilot messages", { deleted, retentionDays: days });
  return deleted;
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

export function getRoviRetentionQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(ROVI_RETENTION_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleRoviRetention(): Promise<void> {
  const queue = getRoviRetentionQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { pattern: "0 3 * * *" },
    },
  );
  log.info("scheduled rovi retention", { cron: "0 3 * * *" });
}

let cachedWorker: Worker | undefined;

export function createRoviRetentionWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    ROVI_RETENTION_QUEUE_NAME,
    async (_job: Job) => {
      const deleted = await purgeOldMessages();
      return { deleted };
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("rovi retention job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job, result: { deleted: number }) => {
    log.debug("rovi retention job completed", {
      jobId: job.id,
      deleted: result.deleted,
    });
  });

  log.info("rovi retention worker started", { queue: ROVI_RETENTION_QUEUE_NAME });
  return cachedWorker;
}
