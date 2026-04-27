import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

// =============================================================
// outbox_events cleanup sweeper (Plan 3 §F.2)
// =============================================================
//
// Deletes outbox rows where publishedAt is set and older than 24h.
// The outbox is fan-out, not a journal — replays beyond 24h come
// from the authoritative revenue_events / credit_ledger tables.
//
// Runs every hour. Batched DELETE (10k rows / batch) so a single
// run can never lock the table or pile up WAL. Stops as soon as a
// batch returns zero rows.

const log = logger.child("outbox-cleanup");

export const OUTBOX_CLEANUP_QUEUE_NAME = "rovenue-outbox-cleanup";

const RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPEAT_EVERY_MS = 60 * 60 * 1000; // hourly
const BATCH_SIZE = 10_000;
const MAX_BATCHES_PER_RUN = 100; // safety brake — 1M rows max per tick
const REPEATABLE_JOB_NAME = "outbox:cleanup";
const REPEATABLE_JOB_ID = "outbox-cleanup-repeatable";

export interface OutboxCleanupResult {
  deleted: number;
  batches: number;
  cutoff: string;
  truncated: boolean;
}

export async function runOutboxCleanup(
  now: Date = new Date(),
): Promise<OutboxCleanupResult> {
  const cutoff = new Date(now.getTime() - RETENTION_WINDOW_MS);
  let deleted = 0;
  let batches = 0;

  for (; batches < MAX_BATCHES_PER_RUN; batches++) {
    const batchDeleted = await drizzle.outboxRepo.deletePublishedOlderThan(
      drizzle.db,
      cutoff,
      BATCH_SIZE,
    );
    deleted += batchDeleted;
    if (batchDeleted < BATCH_SIZE) {
      batches++;
      break;
    }
  }

  const truncated = batches >= MAX_BATCHES_PER_RUN;
  log.info("outbox cleanup sweep complete", {
    deleted,
    batches,
    cutoff: cutoff.toISOString(),
    truncated,
  });
  if (truncated) {
    log.warn("outbox cleanup hit batch ceiling — backlog detected", {
      ceiling: MAX_BATCHES_PER_RUN * BATCH_SIZE,
    });
  }
  return { deleted, batches, cutoff: cutoff.toISOString(), truncated };
}

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

let cachedQueue: Queue | undefined;

export function getOutboxCleanupQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(OUTBOX_CLEANUP_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 30, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 30 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleOutboxCleanup(): Promise<void> {
  const queue = getOutboxCleanupQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("scheduled outbox cleanup", { everyMs: REPEAT_EVERY_MS });
}

let cachedWorker: Worker | undefined;

export function createOutboxCleanupWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    OUTBOX_CLEANUP_QUEUE_NAME,
    async (_job: Job) => runOutboxCleanup(),
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("outbox cleanup job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });
  cachedWorker.on("completed", (job) => {
    log.debug("outbox cleanup job completed", { jobId: job.id });
  });

  log.info("outbox cleanup worker started", {
    queue: OUTBOX_CLEANUP_QUEUE_NAME,
  });
  return cachedWorker;
}
