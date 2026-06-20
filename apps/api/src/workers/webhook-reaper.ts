// =============================================================
// Webhook Reaper — inbound webhook stale-claim recovery worker (W2.4)
// =============================================================
//
// Per-minute BullMQ repeatable job that resets PROCESSING
// webhook_events rows whose claimedAt predates the 5-minute lease.
// This is the safety-net for cases where the claim was acquired but
// the processing worker crashed before completing (BullMQ job lost,
// pod OOM-killed, etc.). The row becomes FAILED + retryCount++ so
// the next delivery attempt can re-claim it and alerting can fire.
//
// Invariant: reclaimStaleWebhookEvents() is idempotent and safe to
// run from multiple instances — only rows that are actually stale
// are updated (the WHERE guard is atomic in Postgres).

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

const log = logger.child("webhook-reaper");

export const WEBHOOK_REAPER_QUEUE_NAME = "rovenue-webhook-reaper";

const REPEAT_EVERY_MS = 60_000; // per-minute — matches rovi-reaper cadence
const REPEATABLE_JOB_NAME = "webhook-reaper:sweep";
const REPEATABLE_JOB_ID = "webhook-reaper-repeatable";

// =============================================================
// Job body
// =============================================================

export interface WebhookReaperResult {
  reclaimed: number;
}

export async function runWebhookReaper(
  now: Date = new Date(),
): Promise<WebhookReaperResult> {
  const reclaimed = await drizzle.webhookEventRepo.reclaimStaleWebhookEvents(
    drizzle.db,
    now,
  );
  if (reclaimed > 0) {
    log.warn("reclaimed orphaned PROCESSING webhook_events", { reclaimed });
  }
  return { reclaimed };
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

export function getWebhookReaperQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(WEBHOOK_REAPER_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Register the per-minute repeatable job. Safe to call multiple times
 * on boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function scheduleWebhookReaper(): Promise<void> {
  const queue = getWebhookReaperQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("scheduled webhook reaper", { everyMs: REPEAT_EVERY_MS });
}

let cachedWorker: Worker | undefined;

export function createWebhookReaperWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    WEBHOOK_REAPER_QUEUE_NAME,
    async (_job: Job): Promise<WebhookReaperResult> => runWebhookReaper(),
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("webhook reaper job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job, result: WebhookReaperResult) => {
    log.debug("webhook reaper job completed", {
      jobId: job.id,
      reclaimed: result.reclaimed,
    });
  });

  log.info("webhook reaper worker started", {
    queue: WEBHOOK_REAPER_QUEUE_NAME,
  });
  return cachedWorker;
}
