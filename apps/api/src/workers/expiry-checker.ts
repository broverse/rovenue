import { Queue, Worker, type Job } from "bullmq";
import { createBullConnection } from "../lib/redis";
import {
  PurchaseStatus,
  RevenueEventType,
  drizzle,
  type Store,
} from "@rovenue/db";
import { EXPIRY_SWEEP_STATUSES as SWEEPABLE } from "@rovenue/shared/subscription-status";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { syncAccess } from "../services/access-engine";

// =============================================================
// Subscription expiry background worker
// =============================================================
//
// Runs every 5 minutes via a BullMQ repeatable job. Queries any
// purchase in a sweepable (non-terminal) status that has slipped past
// its expiresDate — bounded by STATUS, not by a time window, so a
// purchase missed by an earlier run (worker downtime, a per-candidate
// error) is retried on the next run instead of staying ACTIVE forever —
// and transitions them through the state machine:
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
// Per-run batch cap: keeps one 5-minute run from grabbing an unbounded
// backlog. Processed rows leave the sweepable statuses, so successive
// runs naturally drain whatever remains, oldest expiries first.
const MAX_CANDIDATES_PER_RUN = 500;
// Every non-terminal status that can lapse, derived from the shared
// semantics table. Kept in sync with the partial index
// purchases_status_expiresDate_idx by the pg_indexes contract test in
// packages/db (see Task 5).
const EXPIRY_SWEEP_STATUSES: PurchaseStatus[] = [...SWEEPABLE];
const REPEATABLE_JOB_NAME = "expiry:check";
const REPEATABLE_JOB_ID = "expiry-checker-repeatable";

// BILLING_ISSUE is deliberately `sweepable: false` (see the module doc
// above) so the sweep loop this file otherwise runs never touches it —
// a held row's expiresDate is already in the past, and sweeping it the
// instant it appeared would erase the dunning signal. This constant
// bounds a SEPARATE ageing pass (`runBillingIssueAgeing`) that retires
// a held row only once no store could plausibly still be retrying it.
//
// Apple retries a failed renewal for up to 60 days; Google's account
// hold is 30; Stripe's dunning is configurable and shorter — 60 is the
// widest real window, so a row still in BILLING_ISSUE past it is not
// "being retried" any more by any of the three stores.
export const BILLING_ISSUE_MAX_AGE_DAYS = 60;

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
  priceAmount: string | number | null;
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
  const candidates = (await drizzle.purchaseExtRepo.findOverduePurchases(
    drizzle.db,
    {
      now,
      statuses: EXPIRY_SWEEP_STATUSES,
      limit: MAX_CANDIDATES_PER_RUN,
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
    // A PAUSED subscription must not be promoted into GRACE_PERIOD; it only
    // resolves to EXPIRED on lapse (or back to ACTIVE via a resume webhook).
    candidate.status !== PurchaseStatus.PAUSED &&
    candidate.gracePeriodExpires !== null &&
    candidate.gracePeriodExpires > now;

  if (hasActiveGrace) {
    const updated = await drizzle.purchaseRepo.updatePurchaseStatusIf(
      drizzle.db,
      candidate.id,
      candidate.status as PurchaseStatus,
      PurchaseStatus.GRACE_PERIOD,
    );
    if (updated === 0) return "SKIPPED";

    await safeSyncAccess(candidate.subscriberId);
    return "GRACE_PERIOD";
  }

  const updated = await drizzle.purchaseRepo.updatePurchaseStatusIf(
    drizzle.db,
    candidate.id,
    candidate.status as PurchaseStatus,
    PurchaseStatus.EXPIRED,
  );
  if (updated === 0) return "SKIPPED";

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
  const timestamp = new Date().toISOString();

  // No existing tx at this call site — wrap the outbox bridge and the
  // v1 outgoing-webhook write in a minimal transaction of their own so
  // they commit atomically. The outbox insert is unconditional (v2
  // subscribers must get the event even when no v1 webhookUrl is
  // configured); the v1 write keeps its existing webhookUrl/dedupe gates.
  await drizzle.db.transaction(async (tx) => {
    await drizzle.outboxRepo.insert(tx, {
      aggregateType: "SUBSCRIPTION",
      aggregateId: candidate.subscriberId,
      eventType: "subscription.expired",
      payload: {
        projectId: candidate.projectId,
        subscriberId: candidate.subscriberId,
        purchaseId: candidate.id,
        timestamp,
      },
    });

    const webhookUrl = await drizzle.projectRepo.findProjectWebhookUrl(
      tx,
      candidate.projectId,
    );
    if (!webhookUrl) return;

    const existing =
      await drizzle.outgoingWebhookRepo.findRecentOutgoingByPurchaseAndType(
        tx,
        candidate.projectId,
        candidate.subscriberId,
        EXPIRATION_EVENT_TYPE,
        candidate.id,
      );
    if (existing) return;

    const payload = {
      eventType: EXPIRATION_EVENT_TYPE,
      subscriberId: candidate.subscriberId,
      purchaseId: candidate.id,
      timestamp,
    };

    await drizzle.outgoingWebhookRepo.enqueueOutgoingWebhook(tx, {
      projectId: candidate.projectId,
      eventType: EXPIRATION_EVENT_TYPE,
      subscriberId: candidate.subscriberId,
      purchaseId: candidate.id,
      payload,
      url: webhookUrl,
    });
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

  await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
    projectId: candidate.projectId,
    subscriberId: candidate.subscriberId,
    purchaseId: candidate.id,
    productId: candidate.productId,
    type: RevenueEventType.CANCELLATION,
    // Drizzle decimal columns round-trip as strings.
    amount: "0",
    currency,
    amountUsd: "0",
    store: candidate.store,
    eventDate: now,
  });
}

// =============================================================
// BILLING_ISSUE ageing pass
// =============================================================
//
// Separate from runExpiryCheck above: BILLING_ISSUE is not in
// EXPIRY_SWEEP_STATUSES, so the ordinary sweep never sees these rows.
// This pass has its own bounded window (BILLING_ISSUE_MAX_AGE_DAYS)
// instead of the sweep's status-only bound, because a held row's
// expiresDate is already in the past the moment it's stamped — bounding
// by status alone would retire it immediately and erase the dunning
// signal (whether the churn was involuntary). Reuses the same
// candidate-processing helpers as the sweep (safeSyncAccess,
// enqueueExpirationWebhook, recordCancellationRevenue) so a
// BILLING_ISSUE → EXPIRED transition produces the same access sync,
// webhook, and revenue bookkeeping as any other expiry.
//
// updatePurchaseStatusIf only writes `status`, so billingIssueDetectedAt
// is left untouched on this transition — it must survive the lapse as
// the record that the churn was involuntary (see
// services/subscription-state.ts's billingIssueStamp, which likewise
// returns {} for a BILLING_ISSUE → EXPIRED transition).

export interface BillingIssueAgeingResult {
  checked: number;
  expired: number;
}

export async function runBillingIssueAgeing(
  now: Date = new Date(),
): Promise<BillingIssueAgeingResult> {
  const cutoff = new Date(
    now.getTime() - BILLING_ISSUE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  );
  const candidates = (await drizzle.purchaseExtRepo.findAgedBillingIssuePurchases(
    drizzle.db,
    { cutoff, limit: MAX_CANDIDATES_PER_RUN },
  )) as unknown as Candidate[];

  let expired = 0;

  for (const candidate of candidates) {
    try {
      const updated = await drizzle.purchaseRepo.updatePurchaseStatusIf(
        drizzle.db,
        candidate.id,
        PurchaseStatus.BILLING_ISSUE,
        PurchaseStatus.EXPIRED,
      );
      if (updated === 0) continue;

      expired += 1;
      await safeSyncAccess(candidate.subscriberId);
      await enqueueExpirationWebhook(candidate);
      await recordCancellationRevenue(candidate, now);
    } catch (err) {
      log.error("billing-issue ageing processing failed", {
        purchaseId: candidate.id,
        subscriberId: candidate.subscriberId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("billing-issue ageing complete", {
    checked: candidates.length,
    expired,
  });

  return { checked: candidates.length, expired };
}

// =============================================================
// BullMQ queue + worker + scheduling
// =============================================================

let cachedQueue: Queue | undefined;

export function getExpiryQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(EXPIRY_QUEUE_NAME, {
    connection: createBullConnection("expiry-checker"),
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
      const expiry = await runExpiryCheck();
      const ageing = await runBillingIssueAgeing();
      return { ...expiry, billingIssueExpired: ageing.expired };
    },
    {
      connection: createBullConnection("expiry-checker"),
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
