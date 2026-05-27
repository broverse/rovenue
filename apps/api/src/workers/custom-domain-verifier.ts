// =============================================================
// Custom-domain verification retry worker
// =============================================================
//
// Owners usually fix DNS within minutes of attaching a domain. The
// dashboard "Verify" button runs the check inline, but DNS propagation
// can take longer than the operator wants to wait — so this worker
// re-runs `verifyCustomDomain` on the backlog every 5 minutes, only
// touching rows that were last checked > 30 minutes ago. After 7 days
// of failure we stop trying and tag the row as `verification_window_expired`;
// the operator has to delete + recreate to retry.

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { verifyCustomDomain, type VerifyResult } from "../services/custom-domains/verify";

const log = logger.child("custom-domain-verifier");

export const CUSTOM_DOMAIN_VERIFIER_QUEUE_NAME = "rovenue-custom-domain-verifier";

const REPEAT_CRON = "*/5 * * * *"; // every 5 minutes
const REPEATABLE_JOB_NAME = "custom-domain-verifier:sweep";
const REPEATABLE_JOB_ID = "custom-domain-verifier-repeatable";

// Don't re-check a row more often than this — DNS records that just
// changed need time to propagate across resolvers.
const MIN_RECHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 min
// After this window, give up and mark the row as failed.
const VERIFICATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// =============================================================
// Job body
// =============================================================

export type VerifyForRow = (hostname: string, token: string) => Promise<VerifyResult>;

export async function runCustomDomainVerifierSweep(
  now: Date = new Date(),
  verify: VerifyForRow = (host, token) => verifyCustomDomain(host, token),
): Promise<{ verified: number; stillPending: number; expired: number }> {
  // Mark stale unverified rows as failed first — keeps the live verify
  // backlog small. This is idempotent: rows already past the window
  // already have a non-null `verificationFailureReason`, but the bulk
  // update is cheap.
  const expiredCutoff = new Date(now.getTime() - VERIFICATION_WINDOW_MS);
  const expired = await drizzle.customDomainRepo.failExpired(drizzle.db, expiredCutoff);

  const olderThan = new Date(now.getTime() - MIN_RECHECK_INTERVAL_MS);
  const pending = await drizzle.customDomainRepo.listPending(drizzle.db, olderThan);

  let verified = 0;
  for (const row of pending) {
    // Skip rows already past the 7-day window — they were just marked by
    // `failExpired` above, but if the row was created < 5 min ago and is
    // now past the window the bulk update has already handled it.
    if (now.getTime() - row.createdAt.getTime() > VERIFICATION_WINDOW_MS) continue;

    try {
      const result = await verify(row.hostname, row.verificationToken);
      await drizzle.customDomainRepo.updateById(
        drizzle.db,
        row.id,
        result.ok
          ? {
              verifiedAt: now,
              lastCheckedAt: now,
              verificationFailureReason: null,
            }
          : {
              lastCheckedAt: now,
              verificationFailureReason: result.reason,
            },
      );
      if (result.ok) verified++;
    } catch (err) {
      // A single bad row mustn't kill the whole sweep.
      log.warn("verify check threw", {
        id: row.id,
        hostname: row.hostname,
        err: err instanceof Error ? err.message : String(err),
      });
      await drizzle.customDomainRepo.updateById(drizzle.db, row.id, {
        lastCheckedAt: now,
        verificationFailureReason: "resolver_error",
      });
    }
  }

  const stillPending = pending.length - verified;
  if (pending.length > 0 || expired > 0) {
    log.info("custom-domain verify sweep done", {
      checked: pending.length,
      verified,
      stillPending,
      expired,
    });
  }
  return { verified, stillPending, expired };
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

export function getCustomDomainVerifierQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(CUSTOM_DOMAIN_VERIFIER_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleCustomDomainVerifier(): Promise<void> {
  const queue = getCustomDomainVerifierQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { pattern: REPEAT_CRON },
    },
  );
  log.info("scheduled custom-domain verifier", { pattern: REPEAT_CRON });
}

let cachedWorker: Worker | undefined;

export function createCustomDomainVerifierWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    CUSTOM_DOMAIN_VERIFIER_QUEUE_NAME,
    async (_job: Job) => {
      return runCustomDomainVerifierSweep();
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("custom-domain verifier job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("custom-domain verifier job completed", { jobId: job.id });
  });

  log.info("custom-domain verifier worker started", {
    queue: CUSTOM_DOMAIN_VERIFIER_QUEUE_NAME,
  });
  return cachedWorker;
}
