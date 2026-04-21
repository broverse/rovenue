import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import prisma, {
  OutgoingWebhookStatus,
  Prisma,
  PurchaseStatus,
  RevenueEventType,
  drizzle,
  type Store,
} from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { syncAccess } from "../services/access-engine";

// =============================================================
// Subscription expiry background worker
// =============================================================
//
// Runs every 5 minutes via a BullMQ repeatable job. Queries any
// purchases that have slipped past their expiresDate in the last
// 24h (wide enough to catch anything missed during a deploy) and
// transitions them through the state machine:
//
//   ACTIVE/TRIAL + gracePeriodExpires in the future → GRACE_PERIOD
//   ACTIVE/TRIAL/GRACE_PERIOD otherwise               → EXPIRED
//
// On EXPIRED we also reconcile the subscriber's access rows, emit
// an outgoing EXPIRATION webhook, and log a zero-amount CANCELLATION
// revenue event so downstream reporting stays complete.

const log = logger.child("expiry-checker");

export const EXPIRY_QUEUE_NAME = "rovenue-expiry-check";
export const EXPIRATION_EVENT_TYPE = "EXPIRATION";

const REPEAT_EVERY_MS = 5 * 60 * 1000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const REPEATABLE_JOB_NAME = "expiry:check";
const REPEATABLE_JOB_ID = "expiry-checker-repeatable";

// =============================================================
// Query + processing
// =============================================================

interface Candidate {
  id: string;
  projectId: string;
  subscriberId: string;
  productId: string;
  status: PurchaseStatus;
  store: Store;
  expiresDate: Date | null;
  gracePeriodExpires: Date | null;
  priceAmount: Prisma.Decimal | number | null;
  priceCurrency: string | null;
}

export interface ExpiryCheckResult {
  checked: number;
  expired: number;
  movedToGracePeriod: number;
  errors: number;
}

type Outcome = "EXPIRED" | "GRACE_PERIOD" | "SKIPPED";

export async function runExpiryCheck(
  now: Date = new Date(),
): Promise<ExpiryCheckResult> {
  const lookback = new Date(now.getTime() - LOOKBACK_MS);

  const candidates = (await drizzle.purchaseExtRepo.findPurchasesNearExpiry(
    drizzle.db,
    {
      now,
      lookback,
      statuses: [
        PurchaseStatus.ACTIVE,
        PurchaseStatus.GRACE_PERIOD,
        PurchaseStatus.TRIAL,
      ],
    },
  )) as unknown as Candidate[];

  let expired = 0;
  let movedToGracePeriod = 0;
  let errors = 0;

  for (const candidate of candidates) {
    try {
      const outcome = await processCandidate(candidate, now);
      if (outcome === "EXPIRED") expired += 1;
      else if (outcome === "GRACE_PERIOD") movedToGracePeriod += 1;
    } catch (err) {
      errors += 1;
      log.error("purchase expiry processing failed", {
        purchaseId: candidate.id,
        subscriberId: candidate.subscriberId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("expiry check complete", {
    checked: candidates.length,
    expired,
    movedToGracePeriod,
    errors,
  });

  return {
    checked: candidates.length,
    expired,
    movedToGracePeriod,
    errors,
  };
}

async function processCandidate(
  candidate: Candidate,
  now: Date,
): Promise<Outcome> {
  const hasActiveGrace =
    candidate.status !== PurchaseStatus.GRACE_PERIOD &&
    candidate.gracePeriodExpires !== null &&
    candidate.gracePeriodExpires > now;

  if (hasActiveGrace) {
    const updated = await prisma.purchase.updateMany({
      where: { id: candidate.id, status: candidate.status },
      data: { status: PurchaseStatus.GRACE_PERIOD },
    });
    if (updated.count === 0) return "SKIPPED";

    await safeSyncAccess(candidate.subscriberId);
    return "GRACE_PERIOD";
  }

  const updated = await prisma.purchase.updateMany({
    where: { id: candidate.id, status: candidate.status },
    data: { status: PurchaseStatus.EXPIRED },
  });
  if (updated.count === 0) return "SKIPPED";

  await safeSyncAccess(candidate.subscriberId);
  await enqueueExpirationWebhook(candidate);
  await recordCancellationRevenue(candidate, now);

  return "EXPIRED";
}

async function safeSyncAccess(subscriberId: string): Promise<void> {
  try {
    await syncAccess(subscriberId);
  } catch (err) {
    // syncAccess holds a Postgres advisory lock and may fail under
    // heavy contention. Log and continue — the next run will pick
    // up any stragglers.
    log.warn("syncAccess failed during expiry processing", {
      subscriberId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function enqueueExpirationWebhook(candidate: Candidate): Promise<void> {
  const webhookUrl = await drizzle.projectRepo.findProjectWebhookUrl(
    drizzle.db,
    candidate.projectId,
  );
  if (!webhookUrl) return;

  const existing =
    await drizzle.outgoingWebhookRepo.findRecentOutgoingByPurchaseAndType(
      drizzle.db,
      candidate.projectId,
      candidate.subscriberId,
      EXPIRATION_EVENT_TYPE,
      candidate.id,
    );
  if (existing) return;

  const payload: Prisma.InputJsonValue = {
    eventType: EXPIRATION_EVENT_TYPE,
    subscriberId: candidate.subscriberId,
    purchaseId: candidate.id,
    timestamp: new Date().toISOString(),
  };

  await prisma.outgoingWebhook.create({
    data: {
      projectId: candidate.projectId,
      eventType: EXPIRATION_EVENT_TYPE,
      subscriberId: candidate.subscriberId,
      purchaseId: candidate.id,
      payload,
      url: webhookUrl,
      status: OutgoingWebhookStatus.PENDING,
    },
  });
}

async function recordCancellationRevenue(
  candidate: Candidate,
  now: Date,
): Promise<void> {
  const existing = await drizzle.revenueEventRepo.findRecentRevenueEvent(
    drizzle.db,
    candidate.subscriberId,
    candidate.id,
    RevenueEventType.CANCELLATION,
    new Date(0),
  );
  if (existing) return;

  const currency = candidate.priceCurrency ?? "USD";

  await prisma.revenueEvent.create({
    data: {
      projectId: candidate.projectId,
      subscriberId: candidate.subscriberId,
      purchaseId: candidate.id,
      productId: candidate.productId,
      type: RevenueEventType.CANCELLATION,
      amount: new Prisma.Decimal(0),
      currency,
      amountUsd: new Prisma.Decimal(0),
      store: candidate.store,
      eventDate: now,
    },
  });
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

export function getExpiryQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(EXPIRY_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Register the 5-minute repeatable job. Safe to call multiple times
 * on boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function scheduleExpiryCheck(): Promise<void> {
  const queue = getExpiryQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("scheduled expiry checker", { everyMs: REPEAT_EVERY_MS });
}

let cachedWorker: Worker | undefined;

export function createExpiryWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    EXPIRY_QUEUE_NAME,
    async (_job: Job) => {
      return runExpiryCheck();
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("expiry job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("expiry job completed", { jobId: job.id });
  });

  log.info("expiry worker started", { queue: EXPIRY_QUEUE_NAME });
  return cachedWorker;
}
