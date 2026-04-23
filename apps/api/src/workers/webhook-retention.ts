import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

// =============================================================
// webhook_events retention sweeper
// =============================================================
//
// Deletes webhook_events rows older than 90 days on a nightly
// schedule. webhook_events is not a TimescaleDB hypertable
// (the UNIQUE(source, storeEventId) dedup contract is
// incompatible with hypertable partitioning), so retention is
// handled at the application layer instead of via drop_chunks.
//
// The 90-day window matches spec §6.1's retention target; DLQ +
// retry history beyond that is noise.

const log = logger.child("webhook-retention");

export const WEBHOOK_RETENTION_QUEUE_NAME = "rovenue-webhook-retention";

const RETENTION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000; // nightly
const REPEATABLE_JOB_NAME = "webhook:retention";
const REPEATABLE_JOB_ID = "webhook-retention-repeatable";

export interface WebhookRetentionResult {
  deleted: number;
  cutoff: string; // ISO8601 for log inspection
}

export async function runWebhookRetention(
  now: Date = new Date(),
): Promise<WebhookRetentionResult> {
  const cutoff = new Date(now.getTime() - RETENTION_WINDOW_MS);
  const deleted = await drizzle.webhookEventRepo.deleteWebhookEventsOlderThan(
    drizzle.db,
    cutoff,
  );
  log.info("webhook retention sweep complete", {
    deleted,
    cutoff: cutoff.toISOString(),
  });
  return { deleted, cutoff: cutoff.toISOString() };
}

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

let cachedQueue: Queue | undefined;

export function getWebhookRetentionQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(WEBHOOK_RETENTION_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 30, age: 30 * 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 30 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Register the nightly repeatable job. Safe to call multiple times
 * on boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function scheduleWebhookRetention(): Promise<void> {
  const queue = getWebhookRetentionQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("scheduled webhook retention", { everyMs: REPEAT_EVERY_MS });
}

let cachedWorker: Worker | undefined;

export function createWebhookRetentionWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    WEBHOOK_RETENTION_QUEUE_NAME,
    async (_job: Job) => {
      return runWebhookRetention();
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("webhook retention job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("webhook retention job completed", { jobId: job.id });
  });

  log.info("webhook retention worker started", {
    queue: WEBHOOK_RETENTION_QUEUE_NAME,
  });
  return cachedWorker;
}
