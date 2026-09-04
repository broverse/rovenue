import { Queue, Worker, type Job } from "bullmq";
import { drizzle } from "@rovenue/db";
import { createBullConnection } from "../lib/redis";
import { audit } from "../lib/audit";
import { logger } from "../lib/logger";
import {
  accessDriftCircuitBreakerTotal,
  accessDriftDetectedTotal,
  accessDriftHealedTotal,
} from "../lib/metrics";
import { computeDesiredAccess, syncAccess } from "../services/access-engine";

const log = logger.child("access-reconciliation");

// =============================================================
// subscriber_access drift reconciler
// =============================================================
//
// `subscriber_access` is the denormalised table every entitlement check
// reads. `syncAccess` recomputes it correctly — but only when an
// ingestion path calls it. A dropped outbox event, a crashed worker, a
// partial deploy or a bug in any one caller leaves that table silently
// wrong, and until this worker existed nothing in the system would ever
// notice: a subscriber who lost access they paid for files a support
// ticket, and a subscriber who kept access they stopped paying for
// never says a word.
//
// This is the sweep that notices, and heals.
//
// -------------------------------------------------------------
// One truth, not two
// -------------------------------------------------------------
//
// Detection calls `computeDesiredAccess` — the EXACT function
// `syncAccess` writes from (services/access-engine.ts), exported for
// this purpose. There is deliberately no second implementation of "what
// access should this subscriber have": a checker defending a different
// truth than the writer is worse than no checker, because it manufactures
// drift reports for correct data and stays quiet about the real thing.
// This codebase has already paid that price once, in its analytics layer.
//
// -------------------------------------------------------------
// The circuit breaker
// -------------------------------------------------------------
//
// Auto-heal's real risk is not a missed drift, it is a mass revoke. If
// `computeDesiredAccess` is ever wrong, this worker faithfully applies
// that wrongness to every subscriber it touches — at machine speed,
// across every project, with no human in the loop.
//
// So a sweep runs in TWO PASSES:
//
//   Pass 1 measures the whole batch and writes nothing.
//   Pass 2 heals — and only runs if the batch's drift ratio came in
//          under MAX_DRIFT_HEAL_RATIO.
//
// Above the threshold the sweep stops, logs at alert level, increments
// `rovenue_access_drift_circuit_breaker_total`, and leaves the data
// exactly as it found it. A real 5% entitlement drift is an incident for
// a human to look at, not a batch to silently rewrite.
//
// The two passes are why detection cannot heal as it goes: the ratio is
// a property of the batch, so it is not known until every candidate has
// been measured.
//
// -------------------------------------------------------------
// Backfill mode
// -------------------------------------------------------------
//
// On the first sweeps after deploy every subscriber has
// `lastAccessReconciledAt = NULL`, so the batch is the accumulated
// backlog of every drift since the install began rather than "what
// broke recently". `{ backfill: true }` records that fact on each audit
// row (`after.backfill`), so an operator reading the audit log later can
// tell a historical cleanup apart from live drift the sweep caught in
// the act. It changes nothing else: the repair is identical either way,
// because a wrong entitlement is wrong regardless of when it broke.
// The scheduled job always runs with `backfill: false`.

export const ACCESS_RECONCILIATION_QUEUE_NAME = "rovenue-access-reconciliation";

// Per-run cap. Each candidate costs two small indexed reads (its
// purchases, its access rows) plus, if it drifted, one `syncAccess`
// transaction; 200 keeps a run well inside the REPEAT_EVERY_MS interval
// below even on a large install. Stamped rows drop out of the candidate
// set, so successive runs drain the population rather than re-scanning
// its head.
export const MAX_SUBSCRIBERS_PER_SWEEP = 200;

// Every subscriber is re-checked at least this often. 7 days keeps a
// full pass cheap while bounding how long silent drift can persist:
// at 200 per run every 30 minutes a sweep covers 67,200 subscribers a
// week, which is the population size at which this window starts to
// stretch and the cap above should be raised.
export const ACCESS_RECONCILE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// The share of a batch that may drift before the sweep refuses to heal
// it. 5% is far above the background rate a correct system produces —
// drift here comes from lost events and crashes, which are rare and
// uncorrelated — and far below what a broken `computeDesiredAccess`
// would produce, which is close to 100%. Anything in between is
// ambiguous enough that a human should decide.
export const MAX_DRIFT_HEAL_RATIO = 0.05;

// The ratio above is only meaningful once a batch is big enough for a
// ratio to mean anything: one drifted subscriber in a batch of one is
// 100% drift and would trip the breaker every time, so small sweeps
// could never heal at all — the breaker would turn auto-heal off for
// every small install permanently. Below this many candidates the
// breaker does not apply: mass corruption, the thing it exists to
// catch, cannot hide in a batch this small, and every heal still writes
// an audit row either way.
export const MIN_BATCH_FOR_CIRCUIT_BREAKER = 20;

// Twice an hour. Frequent enough that drift introduced by a bad deploy
// is visible within the deploy window, cheap enough that the sweep is
// invisible next to live traffic.
const REPEAT_EVERY_MS = 30 * 60 * 1000;
const REPEATABLE_JOB_NAME = "access-reconciliation:sweep";
const REPEATABLE_JOB_ID = "access-reconciliation-repeatable";

// Recorded on every audit row this sweep writes, so an operator can
// tell an automated repair from a webhook-driven entitlement change.
const SWEEP_SOURCE = "access:reconciliation-sweep";

/**
 * How a subscriber's stored `subscriber_access` rows disagree with what
 * `computeDesiredAccess` says they should be. A subscriber can exhibit
 * more than one class at once; each is counted once per subscriber.
 *
 * - `missing_grant` — access the subscriber SHOULD have and does not.
 *   A paying customer locked out. Usually a `syncAccess` that never ran
 *   after a successful purchase or renewal.
 * - `stale_grant` — an active row whose purchase still exists but no
 *   longer grants that access (expired, refunded, or superseded by a
 *   later purchase). Access being given away.
 * - `wrong_expiry` — the right row from the right purchase, but its
 *   `expiresDate` disagrees with the purchase's. The entitlement is
 *   granted for the wrong window, so it lapses early or late.
 * - `orphan_row` — an active row pointing at a purchase that is no
 *   longer this subscriber's at all (a transfer or merge that moved the
 *   purchases and left the access rows behind). Distinct from
 *   `stale_grant` because the purchase is not merely no longer
 *   granting: it is not in this subscriber's purchase set, which points
 *   at the identity path rather than the billing path.
 */
export type DriftClass =
  | "missing_grant"
  | "stale_grant"
  | "wrong_expiry"
  | "orphan_row";

const DRIFT_CLASSES: readonly DriftClass[] = [
  "missing_grant",
  "stale_grant",
  "wrong_expiry",
  "orphan_row",
];

export interface AccessReconciliationResult {
  /** Subscribers the worklist selected for this run. */
  candidates: number;
  /** Candidates whose stored access disagreed with the desired set. */
  drifted: number;
  /** Drifted subscribers whose access rows were actually rewritten. */
  healed: number;
  /** True if the batch drift ratio was above threshold and nothing was healed. */
  circuitBroken: boolean;
  /** Count of drifted subscribers per class (sums to >= `drifted`). */
  drift: Record<DriftClass, number>;
  /** Candidates whose detection or heal threw — left unstamped for retry. */
  errors: number;
}

interface SubscriberDrift {
  subscriberId: string;
  projectId: string;
  classes: DriftClass[];
}

/** Shape of the summaries written into the audit row's before/after. */
interface AccessSummaryRow {
  accessId: string;
  purchaseId: string;
  isActive: boolean;
  expiresDate: string | null;
}

export async function runAccessReconciliationSweep(
  now: Date = new Date(),
  opts?: { dryRun?: boolean; backfill?: boolean },
): Promise<AccessReconciliationResult> {
  const dryRun = opts?.dryRun ?? false;
  const backfill = opts?.backfill ?? false;
  const staleBefore = new Date(now.getTime() - ACCESS_RECONCILE_STALE_AFTER_MS);

  const candidates =
    await drizzle.accessRepo.selectAccessReconciliationCandidates(drizzle.db, {
      staleBefore,
      limit: MAX_SUBSCRIBERS_PER_SWEEP,
    });

  const drift: Record<DriftClass, number> = {
    missing_grant: 0,
    stale_grant: 0,
    wrong_expiry: 0,
    orphan_row: 0,
  };
  const drifted: SubscriberDrift[] = [];
  // Candidates whose detection or heal threw. They are deliberately NOT
  // stamped, so the next sweep retries them instead of treating a failed
  // check as a clean bill of health for the next week — same rationale
  // as google-reconciliation.ts leaving `lastReconciledAt` untouched on
  // a verification error.
  const unverified = new Set<string>();
  let errors = 0;

  // -------------------------------------------------------------
  // Pass 1 — detect only, write nothing.
  // -------------------------------------------------------------
  // The whole batch is measured before anything is written, because the
  // circuit breaker's ratio is a property of the batch and is not known
  // until the last candidate has been checked.
  for (const candidate of candidates) {
    try {
      const classes = await detectDrift(candidate.id, now);
      if (classes.length === 0) continue;
      for (const driftClass of classes) {
        drift[driftClass] += 1;
        accessDriftDetectedTotal.inc({ class: driftClass });
      }
      drifted.push({
        subscriberId: candidate.id,
        projectId: candidate.projectId,
        classes,
      });
    } catch (err) {
      errors += 1;
      unverified.add(candidate.id);
      log.warn("drift detection failed", {
        subscriberId: candidate.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ratio =
    candidates.length === 0 ? 0 : drifted.length / candidates.length;
  const circuitBroken =
    candidates.length >= MIN_BATCH_FOR_CIRCUIT_BREAKER &&
    ratio > MAX_DRIFT_HEAL_RATIO;

  if (circuitBroken) {
    accessDriftCircuitBreakerTotal.inc();
    log.error(
      "entitlement drift ratio above threshold — refusing to heal, escalate",
      {
        candidates: candidates.length,
        drifted: drifted.length,
        ratio,
        threshold: MAX_DRIFT_HEAL_RATIO,
        drift,
      },
    );
  }

  // -------------------------------------------------------------
  // Pass 2 — heal, but only under the breaker.
  // -------------------------------------------------------------
  let healed = 0;
  if (!circuitBroken && !dryRun) {
    for (const entry of drifted) {
      try {
        const before = await drizzle.accessRepo.findAllAccessBySubscriber(
          drizzle.db,
          entry.subscriberId,
        );
        // The repair is `syncAccess` itself, not a bespoke fix: the sweep
        // must converge on exactly what the live write path would have
        // produced, including its per-subscriber advisory lock, so a
        // sweep racing a live webhook cannot interleave writes.
        await syncAccess(entry.subscriberId);
        const after = await drizzle.accessRepo.findAllAccessBySubscriber(
          drizzle.db,
          entry.subscriberId,
        );
        healed += 1;
        accessDriftHealedTotal.inc();

        // No callerTx: `audit()` opens its own transaction so the
        // per-project advisory lock that serialises the hash chain is
        // actually held for the read-compute-insert. Passing `drizzle.db`
        // as a pseudo-tx would release that lock after the LOCK statement
        // itself, which is the one thing the chain cannot tolerate.
        await audit({
          projectId: entry.projectId,
          userId: null,
          action: "access.drift_repaired",
          resource: "subscriber",
          resourceId: entry.subscriberId,
          before: { access: summarize(before) },
          after: {
            access: summarize(after),
            classes: entry.classes,
            source: SWEEP_SOURCE,
            backfill,
          },
          ipAddress: null,
          userAgent: null,
        });
      } catch (err) {
        errors += 1;
        unverified.add(entry.subscriberId);
        log.warn("drift heal failed", {
          subscriberId: entry.subscriberId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Stamped even when the breaker tripped, and that is deliberate: an
  // un-stamped batch would be re-selected in full every 30 minutes, so
  // the sweep would re-alert on the same subscribers forever and never
  // discover how far the corruption actually extends. Stamping lets the
  // next run sample a DIFFERENT slice — which keeps alerting (a real
  // mass corruption trips the breaker on every slice) while measuring
  // the blast radius. The stamped rows come back when they go stale.
  if (!dryRun) {
    await drizzle.accessRepo.stampAccessReconciled(
      drizzle.db,
      candidates.filter((c) => !unverified.has(c.id)).map((c) => c.id),
      now,
    );
  }

  const result: AccessReconciliationResult = {
    candidates: candidates.length,
    drifted: drifted.length,
    healed,
    circuitBroken,
    drift,
    errors,
  };
  log.info("access reconciliation sweep complete", {
    ...result,
    dryRun,
    backfill,
  });
  return result;
}

/**
 * Compare one subscriber's stored access rows against the authoritative
 * set. Read-only: this never writes, so pass 1 can measure the whole
 * batch before the circuit breaker decides whether pass 2 runs at all.
 *
 * The two reads are not snapshot-isolated, so a live webhook committing
 * between them can make a correct subscriber look drifted. That is
 * tolerated rather than fixed: the "repair" for a false positive is
 * `syncAccess`, which re-derives everything under its own advisory lock
 * and therefore writes nothing, leaving only an audit row whose before
 * and after are identical. The window is milliseconds against a
 * threshold of 5% of a batch, so it cannot move the circuit breaker.
 */
async function detectDrift(
  subscriberId: string,
  now: Date,
): Promise<DriftClass[]> {
  const purchases = await drizzle.accessRepo.findPurchasesWithAccessIds(
    drizzle.db,
    subscriberId,
  );
  const desired = computeDesiredAccess(purchases, now);
  const stored = await drizzle.accessRepo.findAllAccessBySubscriber(
    drizzle.db,
    subscriberId,
  );

  const classes = new Set<DriftClass>();
  // Only ACTIVE rows are compared: an inactive row is `syncAccess`'s own
  // representation of "revoked", not drift. Rows are never deleted.
  const activeStored = stored.filter((r) => r.isActive);
  const purchaseIds = new Set(purchases.map((p) => p.id));

  for (const [accessId, target] of desired) {
    const match = activeStored.find(
      (r) => r.accessId === accessId && r.purchaseId === target.purchaseId,
    );
    if (!match) {
      // Either no row at all, or the row exists but is inactive, or the
      // active row for this access comes from a different purchase. All
      // three mean the subscriber is not currently granted the access
      // their purchases entitle them to.
      classes.add("missing_grant");
      continue;
    }
    if (match.expiresDate?.getTime() !== target.expiresDate?.getTime()) {
      classes.add("wrong_expiry");
    }
  }

  for (const row of activeStored) {
    if (!purchaseIds.has(row.purchaseId)) {
      // The purchase is not this subscriber's any more — a transfer or
      // merge moved it and left the access row behind.
      classes.add("orphan_row");
      continue;
    }
    const target = desired.get(row.accessId);
    if (!target || target.purchaseId !== row.purchaseId) {
      // The purchase is still here but no longer grants this access:
      // it expired, was refunded, or another purchase superseded it.
      classes.add("stale_grant");
    }
  }

  // Stable order so audit rows and logs read the same way every time.
  return DRIFT_CLASSES.filter((c) => classes.has(c));
}

/** Audit-sized projection of an access row — no ids or internal columns
 *  beyond what an operator needs to see what the repair changed. */
function summarize(
  rows: Array<{
    accessId: string;
    purchaseId: string;
    isActive: boolean;
    expiresDate: Date | null;
  }>,
): AccessSummaryRow[] {
  return rows.map((r) => ({
    accessId: r.accessId,
    purchaseId: r.purchaseId,
    isActive: r.isActive,
    expiresDate: r.expiresDate?.toISOString() ?? null,
  }));
}

// =============================================================
// BullMQ queue + worker + scheduling
// =============================================================

let cachedQueue: Queue | undefined;

export function getAccessReconciliationQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(ACCESS_RECONCILIATION_QUEUE_NAME, {
    connection: createBullConnection("access-reconciliation"),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Register the 30-minute repeatable job. Always runs with the default
 * `backfill: false` — see the module doc for what backfill mode is for
 * and why an operator invokes it by hand instead.
 */
export async function scheduleAccessReconciliation(): Promise<void> {
  const queue = getAccessReconciliationQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    { jobId: REPEATABLE_JOB_ID, repeat: { every: REPEAT_EVERY_MS } },
  );
  log.info("scheduled access reconciliation sweep", {
    everyMs: REPEAT_EVERY_MS,
  });
}

let cachedWorker: Worker | undefined;

export function createAccessReconciliationWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    ACCESS_RECONCILIATION_QUEUE_NAME,
    async (_job: Job) => {
      return runAccessReconciliationSweep();
    },
    {
      connection: createBullConnection("access-reconciliation"),
      // One sweep at a time. Two concurrent sweeps would select
      // overlapping candidate sets (nothing is claimed until the stamp
      // at the end) and, worse, each would compute the drift ratio over
      // half the batch — halving the sample the circuit breaker judges.
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("access reconciliation job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  log.info("access reconciliation worker started", {
    queue: ACCESS_RECONCILIATION_QUEUE_NAME,
  });
  return cachedWorker;
}
