// =============================================================
// Funnel claim-token expirer background worker
// =============================================================
//
// Daily BullMQ repeatable job that deletes funnel_claim_tokens
// rows whose `expires_at` is in the past. Universal-link
// plaintext lives for 7 days; the deferred-claim window is
// shorter (24h), so by the time a token expires there's no
// path that can still claim it. Removing the row also
// reclaims the partial unique index on (session_id) so a
// re-issued token (admin-driven flow) doesn't collide.

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

const log = logger.child("funnel-token-expirer");

export const FUNNEL_TOKEN_EXPIRER_QUEUE_NAME = "rovenue-funnel-token-expirer";

const REPEAT_CRON = "0 3 * * *"; // daily at 03:00 UTC
const REPEATABLE_JOB_NAME = "funnel-token-expirer:sweep";
const REPEATABLE_JOB_ID = "funnel-token-expirer-repeatable";

// =============================================================
// Job body
// =============================================================

export async function runFunnelTokenExpirerSweep(
  now: Date = new Date(),
): Promise<{ deleted: number }> {
  const deleted = await drizzle.funnelClaimTokenRepo.markExpired(
    drizzle.db,
    now,
  );
  log.info("expired funnel claim tokens removed", { deleted });
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

export function getFunnelTokenExpirerQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(FUNNEL_TOKEN_EXPIRER_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleFunnelTokenExpirer(): Promise<void> {
  const queue = getFunnelTokenExpirerQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { pattern: REPEAT_CRON },
    },
  );
  log.info("scheduled funnel token expirer", { pattern: REPEAT_CRON });
}

let cachedWorker: Worker | undefined;

export function createFunnelTokenExpirerWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    FUNNEL_TOKEN_EXPIRER_QUEUE_NAME,
    async (_job: Job) => {
      return runFunnelTokenExpirerSweep();
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("funnel token expirer job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("funnel token expirer job completed", { jobId: job.id });
  });

  log.info("funnel token expirer worker started", {
    queue: FUNNEL_TOKEN_EXPIRER_QUEUE_NAME,
  });
  return cachedWorker;
}
