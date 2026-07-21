import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { isBillingEnabled } from "../lib/host-mode";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";
import { buildUsageReport } from "../services/billing/usage";
import {
  completedPeriodStarts,
  shouldLockUsage,
} from "../services/billing/usage-lock-rule";

// =============================================================
// Usage-cap sweep worker (Plausible model)
// =============================================================
//
// Daily BullMQ repeatable job, cloud mode only. Per project with a
// billing subscription:
//   1. buildUsageReport — persists current-period snapshots + the
//      soft/hard cap warn flags (existing behavior, now guaranteed
//      at least daily instead of only on usage-page views).
//   2. applyUsageLockState — flips projects.usage_locked_at per the
//      two-consecutive-completed-periods rule. SDK ingest is never
//      blocked; only the dashboard guard reads the lock.

const log = logger.child("usage-cap-sweeper");

export const USAGE_CAP_SWEEP_QUEUE_NAME = "rovenue-usage-cap-sweep";
const REPEATABLE_JOB_NAME = "usage-cap:sweep";
const REPEATABLE_JOB_ID = "usage-cap:sweep:repeatable";
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluate + apply the lock state for one project. Exported for tests.
 * Returns what changed so the sweep loop can log meaningfully.
 */
export async function applyUsageLockState(
  projectId: string,
  now: Date,
): Promise<"locked" | "unlocked" | "unchanged"> {
  const project = await drizzle.projectRepo.findProjectById(drizzle.db, projectId);
  if (!project) return "unchanged";

  const periods = completedPeriodStarts(now);
  const rows = await drizzle.usageSnapshotRepo.findSnapshotsForPeriodStarts(
    drizzle.db,
    projectId,
    [...periods],
  );
  const wantLock = shouldLockUsage(rows, periods);
  const isLocked = project.usageLockedAt != null;
  if (wantLock === isLocked) return "unchanged";

  const lockedAt = wantLock ? now : null;
  await drizzle.db.transaction(async (tx) => {
    await drizzle.projectRepo.setUsageLockedAt(tx, projectId, lockedAt);
    await drizzle.outboxRepo.insert(tx, {
      aggregateType: "BILLING",
      aggregateId: projectId,
      eventType: wantLock
        ? "billing.usage_lock.applied"
        : "billing.usage_lock.cleared",
      payload: { projectId, lockedAt: lockedAt?.toISOString() ?? null },
    });
    await audit(
      {
        projectId,
        userId: "system",
        action: "update",
        resource: "project",
        resourceId: projectId,
        before: { usageLockedAt: project.usageLockedAt ?? null },
        after: { usageLockedAt: lockedAt },
      },
      tx,
    );
  });
  log.info(wantLock ? "usage lock applied" : "usage lock cleared", { projectId });
  return wantLock ? "locked" : "unlocked";
}

export async function sweepUsageCaps(now = new Date()): Promise<void> {
  if (!isBillingEnabled()) return;
  const projectIds =
    await drizzle.billingSubscriptionRepo.listProjectIdsWithBillingSubscription(
      drizzle.db,
    );
  for (const projectId of projectIds) {
    try {
      await buildUsageReport(drizzle.db, projectId);
      await applyUsageLockState(projectId, now);
    } catch (err) {
      log.warn("sweep failed for project", {
        projectId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
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

export function getUsageCapSweepQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(USAGE_CAP_SWEEP_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 30, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 30 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Register the daily repeatable job. Safe to call multiple times on
 * boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function scheduleUsageCapSweep(): Promise<void> {
  const queue = getUsageCapSweepQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("usage-cap sweep repeatable job registered", {
    everyMs: REPEAT_EVERY_MS,
  });
}

let cachedWorker: Worker | undefined;

export function createUsageCapSweeperWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    USAGE_CAP_SWEEP_QUEUE_NAME,
    async (_job: Job) => {
      return sweepUsageCaps();
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("usage-cap sweep job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  return cachedWorker;
}
