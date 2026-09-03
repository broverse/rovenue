import { Queue, Worker, type Job } from "bullmq";
import { createBullConnection } from "../lib/redis";
import {
  PurchaseStatus,
  RevenueEventType,
  Store,
  drizzle,
  type Db,
} from "@rovenue/db";
import { logger } from "../lib/logger";
import { audit, type AuditTx } from "../lib/audit";
import { syncAccess } from "../services/access-engine";
import { loadGoogleCredentials } from "../lib/project-credentials";
import { guardStatusWrite } from "../services/subscription-transition-guard";
import {
  verifyGoogleSubscription,
  type GoogleVerifyConfig,
} from "../services/google/google-verify";
import { mapSubscriptionStateToStatus } from "../services/google/google-mappers";
import { billingIssueStamp } from "../services/subscription-state";
import type {
  GoogleServiceAccountCredentials,
  GoogleSubscriptionPurchaseV2,
  GoogleSubscriptionState,
} from "../services/google/google-types";

const log = logger.child("google-reconciliation");

// Mirrors packages/db's `GoogleReconciliationCandidate` shape (the repo
// module isn't a public subpath export — same reason expiry-checker.ts
// re-declares its own local `Candidate` interface for `ExpiryCandidate`
// rather than importing across the package boundary).
interface GoogleReconciliationCandidate {
  id: string;
  projectId: string;
  subscriberId: string;
  productId: string;
  productIdentifier: string;
  status: PurchaseStatus;
  expiresDate: Date | null;
  storeTransactionId: string;
  originalTransactionId: string;
  priceAmount: string | null;
  priceCurrency: string | null;
  lastReconciledAt: Date | null;
}

// =============================================================
// Google reconciliation sweep
// =============================================================
//
// Google's RTDN push is best-effort — Pub/Sub can drop a message, a
// project's endpoint can be down when it fires, our own worker can
// crash mid-claim. When that happens, a purchase silently drifts:
// Rovenue keeps serving an ACTIVE (or GRACE_PERIOD, or PAUSED)
// entitlement for a subscription Google itself has already moved on —
// or keeps a row OUT of BILLING_ISSUE (Task 4, 2026-09-04) that Google
// already placed on account hold.
// This sweep is the backstop — it asks Google directly, for the
// purchases most likely to have drifted, and corrects the row the
// same way a live webhook would: guarded status write, entitlement
// sync, and an outbox event so every configured integration sees the
// same correction a webhook would have delivered.
//
// Reuses `verifyGoogleSubscription` + `mapSubscriptionStateToStatus`
// (services/google/*) — the EXACT functions the live RTDN path calls.
// `services/import/verify-store-clients.ts` is this repo's existing
// precedent for calling that layer without doing subscriber
// reconciliation itself; a second Google verification path would
// drift from the first, which is the failure this codebase has
// already paid for more than once elsewhere.
//
// -------------------------------------------------------------
// Candidate selection (bounding the work)
// -------------------------------------------------------------
//
// Google's Play Developer API is rate-limited and a project may hold
// millions of purchases, so this sweep can never scan "everything
// due." Candidates are:
//   (a) status ACTIVE but past `expiresDate` — the EXPIRED RTDN never
//       arrived, or arrived and was lost before it committed.
//   (b) not reconciled within RECONCILE_STALE_AFTER_MS, oldest first
//       (NULL `lastReconciledAt` — never checked — sorts first).
// Both are capped, together, at MAX_CANDIDATES_PER_SWEEP per run —
// see purchases-ext.ts's `selectGoogleReconciliationCandidateIds` /
// `claimGoogleReconciliationCandidateById` for the exact predicate
// (kept in sync with the `googleReconciliationIdx` partial index,
// migration 0114).
//
// -------------------------------------------------------------
// The first-run burst — decided here, not left for production
// -------------------------------------------------------------
//
// On a project's very first sweep, EVERY sweepable Google purchase has
// `lastReconciledAt = NULL`, so the candidate set is every Google
// purchase that has drifted since RTDN first started missing events for
// this project — which, for a self-hosted install with a long history,
// could be a real backlog. Emitting a live `subscription.*` outbox
// event for each one would hand every configured integration a burst of
// state changes for subscribers whose real transition happened days,
// weeks, or months ago — at best noise, at worst a dunning/win-back
// campaign firing on stale information.
//
// Decision: an explicit BACKFILL MODE (`{ backfill: true }`), not a
// low cap. A low cap alone doesn't fix this — it only slows the flood
// down; the scheduled sweep still eventually emits one event per
// historical drift it finds, because it has no way to tell "genuinely
// new drift" apart from "backlog from before this feature existed."
// Backfill mode still updates the purchase, still syncs entitlements,
// and still records the zero-amount CANCELLATION revenue event
// (ClickHouse-only — see google-mappers.ts's REVENUE_EVENT aggregate,
// never fanned out to CUSTOM_WEBHOOK/providers), so internal
// correctness (paywall gating, MRR/churn) is fixed immediately. It
// ONLY withholds the externally-visible outbox row. An operator runs
// `runGoogleReconciliationSweep(new Date(), { backfill: true })`
// (repeatedly, respecting MAX_CANDIDATES_PER_SWEEP, until the backlog
// is drained) once after deploying this feature; the scheduled
// repeatable job below always runs with `backfill: false`, so any
// drift found AFTER that point — the case the sweep exists for — is
// reported live, same as a webhook would.

export const GOOGLE_RECONCILIATION_QUEUE_NAME = "rovenue-google-reconciliation";

// Per-run cap. Each candidate costs one live Play Developer API call;
// this keeps one run's request volume small relative to Google's
// per-project quota even though a self-hosted install may hold
// millions of purchases. Processed rows leave the sweepable statuses
// or get a fresh `lastReconciledAt`, so successive runs drain the
// backlog instead of re-scanning it.
export const MAX_CANDIDATES_PER_SWEEP = 200;

// A purchase not reconciled within this window is re-verified even if
// nothing else flagged it — Google's RTDN has no delivery SLA, so a
// purely time-based backstop catches a silently-dropped message that
// `expiresDate` alone would not (e.g. a lost CANCELED or IN_GRACE_PERIOD
// notification that hasn't reached expiry yet).
export const RECONCILE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const REPEAT_EVERY_MS = 15 * 60 * 1000;
const REPEATABLE_JOB_NAME = "google-reconciliation:sweep";
const REPEATABLE_JOB_ID = "google-reconciliation-repeatable";

const SWEEP_SOURCE = "google:reconciliation-sweep";

// =============================================================
// Verification dependency seam
// =============================================================
//
// The sweep's OWN logic (claim, guard, write, audit, outbox) is what
// this file's tests exercise against a real Postgres. The live Google
// HTTP call is swapped for a fake in tests via this seam — same shape
// `services/import/verify.ts`'s `ImportVerifyDeps` uses, and for the
// same reason: nothing here re-implements verification, it only
// injects it.

export interface GoogleReconciliationDeps {
  loadVerifyConfig: (projectId: string) => Promise<GoogleVerifyConfig>;
  verifySubscription: (
    config: GoogleVerifyConfig,
    purchaseToken: string,
  ) => Promise<GoogleSubscriptionPurchaseV2>;
}

async function loadGoogleVerifyConfig(
  projectId: string,
): Promise<GoogleVerifyConfig> {
  const creds = await loadGoogleCredentials(projectId);
  if (!creds) {
    throw new Error(
      `google-reconciliation: project ${projectId} has no Google Play credentials configured`,
    );
  }
  return {
    packageName: creds.packageName,
    credentials: creds.serviceAccount as GoogleServiceAccountCredentials,
  };
}

const defaultDeps: GoogleReconciliationDeps = {
  loadVerifyConfig: loadGoogleVerifyConfig,
  verifySubscription: verifyGoogleSubscription,
};

// =============================================================
// Core sweep
// =============================================================

export interface GoogleReconciliationResult {
  /** Candidates the worklist selected for this run. */
  candidates: number;
  /** Successfully verified against Google (corrected + confirmed + rejected). */
  checked: number;
  /** Verified, and Google's state differed — the row was corrected. */
  corrected: number;
  /** Verified, and Google confirmed our stored state was already right. */
  confirmed: number;
  /** Verified, differed, but the state machine withheld the write (terminal row). */
  rejected: number;
  /** Claimed by a concurrent sweep, or no longer eligible by claim time. */
  skipped: number;
  /** Could not verify (missing credentials, network/quota error). */
  errors: number;
}

type ProcessOutcome =
  | "corrected"
  | "confirmed"
  | "rejected"
  | "skipped"
  | "error";

export async function runGoogleReconciliationSweep(
  now: Date = new Date(),
  opts?: { backfill?: boolean; deps?: GoogleReconciliationDeps },
): Promise<GoogleReconciliationResult> {
  const deps = opts?.deps ?? defaultDeps;
  const backfill = opts?.backfill ?? false;
  const staleBefore = new Date(now.getTime() - RECONCILE_STALE_AFTER_MS);

  const ids = await drizzle.purchaseExtRepo.selectGoogleReconciliationCandidateIds(
    drizzle.db,
    { now, staleBefore, limit: MAX_CANDIDATES_PER_SWEEP },
  );

  const tally: GoogleReconciliationResult = {
    candidates: ids.length,
    checked: 0,
    corrected: 0,
    confirmed: 0,
    rejected: 0,
    skipped: 0,
    errors: 0,
  };

  for (const id of ids) {
    const outcome = await processCandidate({ id, now, staleBefore, backfill, deps });
    switch (outcome) {
      case "corrected":
        tally.checked += 1;
        tally.corrected += 1;
        break;
      case "confirmed":
        tally.checked += 1;
        tally.confirmed += 1;
        break;
      case "rejected":
        tally.checked += 1;
        tally.rejected += 1;
        break;
      case "skipped":
        tally.skipped += 1;
        break;
      case "error":
        tally.errors += 1;
        break;
    }
  }

  log.info("google reconciliation sweep complete", { ...tally, backfill });
  return tally;
}

async function processCandidate(args: {
  id: string;
  now: Date;
  staleBefore: Date;
  backfill: boolean;
  deps: GoogleReconciliationDeps;
}): Promise<ProcessOutcome> {
  const { id, now, staleBefore, backfill, deps } = args;
  let subscriberIdToSync: string | null = null;

  const outcome = await drizzle.db.transaction(async (tx) => {
    const candidate = (await drizzle.purchaseExtRepo.claimGoogleReconciliationCandidateById(
      tx as unknown as Db,
      { id, now, staleBefore },
    )) as unknown as GoogleReconciliationCandidate | null;
    if (!candidate) return "skipped" as const;

    let subscription: GoogleSubscriptionPurchaseV2;
    try {
      const config = await deps.loadVerifyConfig(candidate.projectId);
      subscription = await deps.verifySubscription(
        config,
        candidate.storeTransactionId,
      );
    } catch (err) {
      log.warn("google reconciliation verify failed", {
        purchaseId: candidate.id,
        projectId: candidate.projectId,
        err: err instanceof Error ? err.message : String(err),
      });
      // No writes happened — the transaction commits with nothing
      // changed, releasing the row lock. `lastReconciledAt` is
      // deliberately left untouched so this candidate is retried
      // (not skipped) on the next sweep.
      return "error" as const;
    }

    const newStatus = mapSubscriptionStateToStatus(
      subscription.subscriptionState as GoogleSubscriptionState,
    );
    const { expiresDate, autoRenewStatus } = resolveLineItem(
      subscription,
      candidate,
    );

    if (newStatus === candidate.status) {
      await drizzle.purchaseRepo.updatePurchase(tx as unknown as Db, candidate.id, {
        lastReconciledAt: now,
      });
      return "confirmed" as const;
    }

    const guard = await guardStatusWrite({
      db: tx as unknown as Db,
      projectId: candidate.projectId,
      store: Store.PLAY_STORE,
      storeTransactionId: candidate.storeTransactionId,
      to: newStatus,
      source: SWEEP_SOURCE,
      eventTime: now,
    });

    if (!guard.apply) {
      // guardStatusWrite already wrote a `subscription.transition_rejected`
      // audit row (e.g. the row is REFUNDED/REVOKED — absorbing). Still
      // record that we checked it.
      await drizzle.purchaseRepo.updatePurchase(tx as unknown as Db, candidate.id, {
        lastReconciledAt: now,
      });
      return "rejected" as const;
    }

    await drizzle.purchaseRepo.updatePurchase(tx as unknown as Db, candidate.id, {
      status: newStatus,
      expiresDate,
      autoRenewStatus,
      lastStoreEventAt: now,
      lastReconciledAt: now,
      // Task 4 (2026-09-04): mapSubscriptionStateToStatus can now resolve
      // an ON_HOLD state to BILLING_ISSUE, so this sweep is itself an
      // ingestion path for that status same as the live RTDN — stamp/clear
      // billingIssueDetectedAt exactly as google-webhook.ts does.
      ...billingIssueStamp(candidate.status, newStatus, now),
    });

    await audit(
      {
        projectId: candidate.projectId,
        userId: "system",
        action: "subscription.reconciled",
        resource: "purchase",
        resourceId: candidate.id,
        before: { status: candidate.status },
        after: { status: newStatus, source: SWEEP_SOURCE, backfill },
        ipAddress: null,
        userAgent: null,
      },
      tx as unknown as AuditTx,
    );

    if (newStatus === PurchaseStatus.EXPIRED) {
      // Mirrors expiry-checker.ts's own zero-amount CANCELLATION
      // record: ClickHouse-only (REVENUE_EVENT aggregate, never fanned
      // out to CUSTOM_WEBHOOK/providers — see integrations-fanout's
      // SUBSCRIPTION_BRIDGE_EVENT_KEYS filter), so it is safe to
      // write even in backfill mode.
      const existing = await drizzle.revenueEventRepo.findRecentRevenueEvent(
        tx as unknown as Db,
        candidate.subscriberId,
        candidate.id,
        RevenueEventType.CANCELLATION,
        new Date(0),
      );
      if (!existing) {
        await drizzle.revenueEventRepo.createRevenueEvent(tx as unknown as Db, {
          projectId: candidate.projectId,
          subscriberId: candidate.subscriberId,
          purchaseId: candidate.id,
          productId: candidate.productId,
          type: RevenueEventType.CANCELLATION,
          amount: "0",
          currency: candidate.priceCurrency ?? "USD",
          amountUsd: "0",
          store: Store.PLAY_STORE,
          eventDate: now,
        });
      }
    }

    if (!backfill) {
      const eventType = reconciliationOutboxEventType(newStatus);
      if (eventType) {
        await drizzle.outboxRepo.insert(tx as unknown as Db, {
          aggregateType: "SUBSCRIPTION",
          aggregateId: candidate.subscriberId,
          eventType,
          payload: {
            projectId: candidate.projectId,
            subscriberId: candidate.subscriberId,
            purchaseId: candidate.id,
            previousStatus: candidate.status,
            status: newStatus,
            timestamp: now.toISOString(),
            source: SWEEP_SOURCE,
          },
        });
      }
    }

    subscriberIdToSync = candidate.subscriberId;
    return "corrected" as const;
  });

  if (outcome === "corrected" && subscriberIdToSync) {
    await safeSyncAccess(subscriberIdToSync);
  }

  return outcome;
}

/**
 * Maps a reconciled status onto an EXISTING public event key — this
 * sweep mints NO new key. `mapSubscriptionStateToStatus` only ever
 * returns ACTIVE / GRACE_PERIOD / BILLING_ISSUE / PAUSED / EXPIRED (Task
 * 4, 2026-09-04, added BILLING_ISSUE for a Google account hold), so those
 * are the only cases handled; the others are unreachable defense-in-depth.
 */
function reconciliationOutboxEventType(
  status: PurchaseStatus,
): string | null {
  switch (status) {
    case PurchaseStatus.EXPIRED:
      return "subscription.expired";
    case PurchaseStatus.GRACE_PERIOD:
      return "subscription.grace_period";
    case PurchaseStatus.BILLING_ISSUE:
      // An account hold discovered here means we never saw its ON_HOLD
      // RTDN either — reuse the same public key the live webhook path
      // emits for DID_FAIL_TO_RENEW/SUBSCRIPTION_ON_HOLD (see
      // packages/shared/src/store-event-normalization.ts) so every
      // configured integration sees one consistent event regardless of
      // which path caught it.
      return "subscription.billing_issue";
    case PurchaseStatus.PAUSED:
      return "subscription.paused";
    case PurchaseStatus.ACTIVE:
      // A prior GRACE_PERIOD/BILLING_ISSUE/PAUSED row Google now reports
      // ACTIVE again recovered without us ever seeing the RTDN for it.
      return "subscription.recovered";
    default:
      return null;
  }
}

/**
 * Picks the line item matching this purchase's product identifier
 * (falling back to the first, logged) the same way
 * `verify-store-clients.ts`'s `verifyGoogleAnchor` does — a
 * subscription can carry more than one line item, and only the
 * matching one's `expiryTime`/`autoRenewingPlan` describes THIS
 * purchase.
 */
function resolveLineItem(
  subscription: GoogleSubscriptionPurchaseV2,
  candidate: GoogleReconciliationCandidate,
): { expiresDate: Date | null; autoRenewStatus: boolean | null } {
  const lineItems = subscription.lineItems ?? [];
  const matched =
    lineItems.find((item) => item.productId === candidate.productIdentifier) ??
    lineItems[0];
  if (lineItems.length > 0 && !matched) {
    log.warn(
      "google reconciliation: no line item matches the purchase's product identifier — using the subscription's first",
      { purchaseId: candidate.id, productIdentifier: candidate.productIdentifier },
    );
  }
  return {
    expiresDate: matched?.expiryTime ? new Date(matched.expiryTime) : candidate.expiresDate,
    autoRenewStatus: matched?.autoRenewingPlan?.autoRenewEnabled ?? null,
  };
}

async function safeSyncAccess(subscriberId: string): Promise<void> {
  try {
    await syncAccess(subscriberId);
  } catch (err) {
    // Same rationale as expiry-checker.ts's safeSyncAccess: syncAccess
    // takes a Postgres advisory lock and can fail under contention.
    // Log and continue — the purchase row is already correct; the next
    // sweep (or any other access-touching path) will reconcile access.
    log.warn("syncAccess failed during google reconciliation", {
      subscriberId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================
// BullMQ queue + worker + scheduling
// =============================================================

let cachedQueue: Queue | undefined;

export function getGoogleReconciliationQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(GOOGLE_RECONCILIATION_QUEUE_NAME, {
    connection: createBullConnection("google-reconciliation"),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Register the 15-minute repeatable job. Always runs with the default
 * `backfill: false` — see the module doc for why the first-run burst
 * is handled by an operator-invoked backfill call instead of a
 * scheduling flag.
 */
export async function scheduleGoogleReconciliation(): Promise<void> {
  const queue = getGoogleReconciliationQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("scheduled google reconciliation sweep", { everyMs: REPEAT_EVERY_MS });
}

let cachedWorker: Worker | undefined;

export function createGoogleReconciliationWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    GOOGLE_RECONCILIATION_QUEUE_NAME,
    async (_job: Job) => {
      return runGoogleReconciliationSweep();
    },
    {
      connection: createBullConnection("google-reconciliation"),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("google reconciliation job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("google reconciliation job completed", { jobId: job.id });
  });

  log.info("google reconciliation worker started", {
    queue: GOOGLE_RECONCILIATION_QUEUE_NAME,
  });
  return cachedWorker;
}
