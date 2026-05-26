// =============================================================
// digest-scheduler-entry — BullMQ wiring
// =============================================================
//
// Wires the hourly daily-digest tick and the Monday-09:00
// weekly-digest tick to BullMQ. Both ticks run hourly (cron
// "0 * * * *") because the per-tick handler does its own
// "is anyone at local 09:00 right now?" check via
// timezonesAtLocalHour. The weekly tick adds a `dow=1` filter
// in addition to that hour check.

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { getClickHouseClient, isClickHouseConfigured } from "../lib/clickhouse";
import { getDb } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import {
  runDailyTick,
  runWeeklyTick,
  type DigestSchedulerDeps,
} from "./digest-scheduler";

export const DIGEST_QUEUE_NAME = "notifier-digest";
export const DAILY_JOB_NAME = "digest.daily";
export const WEEKLY_JOB_NAME = "digest.weekly";

let queueRedis: Redis | null = null;
let workerRedis: Redis | null = null;
let queue: Queue | null = null;
let worker: Worker | null = null;

function buildConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

function buildDeps(): DigestSchedulerDeps {
  return {
    db: getDb(),
    ch: isClickHouseConfigured() ? getClickHouseClient() : null,
    logger,
  };
}

export async function scheduleDigestTicks(): Promise<void> {
  if (!queue) {
    queueRedis = buildConnection();
    queue = new Queue(DIGEST_QUEUE_NAME, {
      connection: queueRedis,
      defaultJobOptions: {
        removeOnComplete: { count: 50, age: 7 * 24 * 60 * 60 },
        removeOnFail: { count: 200, age: 30 * 24 * 60 * 60 },
      },
    });
  }
  // Hourly daily tick. The handler itself decides whether any
  // timezone is currently at 09:00 local.
  await queue.add(
    DAILY_JOB_NAME,
    {},
    {
      jobId: "digest-daily-repeatable",
      repeat: { pattern: "0 * * * *" },
    },
  );
  // Weekly tick: Mondays at the top of every hour. The handler
  // gates on local-09:00 just like the daily tick; running
  // hourly on Mondays means every timezone gets its 09:00 hit.
  await queue.add(
    WEEKLY_JOB_NAME,
    {},
    {
      jobId: "digest-weekly-repeatable",
      repeat: { pattern: "0 * * * 1" },
    },
  );
  logger.info("digest-scheduler: scheduled");
}

export function startDigestScheduler(): Worker {
  if (worker) return worker;
  workerRedis = buildConnection();
  worker = new Worker(
    DIGEST_QUEUE_NAME,
    async (job: Job) => {
      const deps = buildDeps();
      if (job.name === DAILY_JOB_NAME) {
        return runDailyTick(deps);
      }
      if (job.name === WEEKLY_JOB_NAME) {
        return runWeeklyTick(deps);
      }
      logger.warn("digest-scheduler: unknown job", { name: job.name });
    },
    {
      connection: workerRedis,
      concurrency: 1,
    },
  );
  worker.on("failed", (job, err) => {
    logger.error("digest-scheduler.failed", {
      jobName: job?.name,
      err: err.message,
    });
  });
  worker.on("error", (err) => {
    logger.error("digest-scheduler.error", { err: err.message });
  });
  logger.info("digest-scheduler: worker started");
  return worker;
}

export async function stopDigestScheduler(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (workerRedis) {
    workerRedis.disconnect();
    workerRedis = null;
  }
  if (queueRedis) {
    queueRedis.disconnect();
    queueRedis = null;
  }
}
