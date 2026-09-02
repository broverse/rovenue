import { Queue, Worker, type Job } from "bullmq";
import { createBullConnection } from "../lib/redis";
import { drizzle } from "@rovenue/db";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";
import { EXPERIMENT_SCHEDULER_SWEEP_INTERVAL_MS } from "../lib/experiment-constants";
import { invalidateExperimentCache } from "../services/experiment-engine";
import { computeExperimentResults } from "../services/experiment-results";
import { stopExperimentWithWinner } from "../routes/dashboard/experiments";

// =============================================================
// Experiment scheduler worker (spec §4.5 / plan Task 9)
// =============================================================
//
// Repeatable BullMQ job that:
//   1. Starts DRAFT experiments whose `scheduledStartAt` has arrived AND
//      whose `startAfterExperimentId` predecessor (if any) has reached
//      COMPLETED — chaining successors into a sequence.
//   2. Stops RUNNING experiments whose `scheduledEndAt` has arrived, via
//      the SAME manual stop-with-winner transition
//      (`routes/dashboard/experiments.ts` `stopExperimentWithWinner`),
//      including its placement healing. `autoWinnerOnStop` gates whether
//      that stop carries a winner at all: false (the default) never picks
//      one; true asks the decision engine (`computeExperimentResults`)
//      and ships ONLY when `recommendation.shipRecommended` is true — the
//      refund guardrail and every other stopping-rule gate are already
//      baked into that flag, so this worker never re-derives the rule.
//
// Concurrency: every state transition is claimed with a conditional
// UPDATE ... WHERE ... RETURNING (the 2026-08-24 stability-batch pattern —
// see `claimExperimentForScheduledStart` / `claimExperimentForScheduledStop`
// in packages/db/src/drizzle/repositories/experiments.ts), never a SELECT
// followed by an UPDATE, so two API replicas sweeping at once cannot both
// win the same row.

const log = logger.child("experiment-scheduler");

export const EXPERIMENT_SCHEDULER_QUEUE_NAME = "rovenue-experiment-scheduler";
const REPEATABLE_JOB_NAME = "experiment-scheduler:sweep";
const REPEATABLE_JOB_ID = "experiment-scheduler-repeatable";

export interface ExperimentSchedulerSweepResult {
  started: number;
  stopped: number;
  skipped: number;
}

/**
 * Attempts to start every DRAFT experiment currently due. The candidate
 * read is loose (see `findScheduledStartCandidates`'s doc comment); the
 * claim's own WHERE clause is what's authoritative, so a stale candidate
 * list can only waste a claim attempt, never double-start.
 */
async function sweepStarts(now: Date): Promise<{ started: number; skipped: number }> {
  const candidates = await drizzle.experimentRepo.findScheduledStartCandidates(
    drizzle.db,
    now,
  );

  let started = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    try {
      const claimed = await drizzle.db.transaction(async (tx) => {
        const row = await drizzle.experimentRepo.claimExperimentForScheduledStart(
          tx,
          candidate.id,
          now,
        );
        if (!row) return null;

        // Attributed to the scheduler, not a user — the audit chain must
        // answer "who started this" truthfully, and inside the SAME
        // transaction as the claim so a crash between the two can never
        // leave an unaudited transition.
        await audit(
          {
            projectId: row.projectId,
            userId: "system",
            action: "experiment.started",
            resource: "experiment",
            resourceId: row.id,
            before: { status: "DRAFT" },
            after: { status: "RUNNING" },
          },
          tx,
        );
        return row;
      });

      if (!claimed) {
        // Lost the race (another replica claimed it first) or the
        // candidate stopped being eligible between the read and the
        // claim (predecessor un-completed is impossible; a status change
        // via a manual action is not). Either way, not an error.
        skipped += 1;
        continue;
      }

      await invalidateExperimentCache(claimed.projectId);
      started += 1;
    } catch (err) {
      log.error("scheduled start failed", {
        experimentId: candidate.id,
        err: err instanceof Error ? err.message : String(err),
      });
      skipped += 1;
    }
  }

  return { started, skipped };
}

/**
 * Attempts to stop every RUNNING experiment past its `scheduledEndAt`.
 * The claim (`claimExperimentForScheduledStop`) clears `scheduledEndAt`
 * as its single-flight lock BEFORE the actual stop transition runs, since
 * that transition may need an async ClickHouse round-trip
 * (`computeExperimentResults`) to decide `autoWinnerOnStop`'s winner and
 * cannot itself be the atomic claim. If the stop then fails, the claim is
 * released (`scheduledEndAt` restored) so a later sweep can retry rather
 * than leaving the row claimed-but-never-stopped forever.
 */
async function sweepStops(now: Date): Promise<{ stopped: number; skipped: number }> {
  const candidates = await drizzle.experimentRepo.findScheduledStopCandidates(
    drizzle.db,
    now,
  );

  let stopped = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const claimed = await drizzle.experimentRepo.claimExperimentForScheduledStop(
      drizzle.db,
      candidate.id,
      now,
    );
    if (!claimed) {
      skipped += 1;
      continue;
    }

    try {
      const experiment = await drizzle.experimentRepo.findExperimentById(
        drizzle.db,
        claimed.id,
      );
      if (!experiment) {
        skipped += 1;
        continue;
      }

      let winnerVariantId: string | undefined;
      if (experiment.autoWinnerOnStop) {
        // §4.1's decision rule, not a second implementation of it: ship
        // ONLY when the engine says every gate passed — a leader that
        // fails the refund guardrail (or any other clause) is not shipped
        // because `shipRecommended` is already false for it.
        const results = await computeExperimentResults(
          experiment.id,
          experiment.projectId,
        );
        if (
          results.recommendation.shipRecommended &&
          results.recommendation.leadingVariantId
        ) {
          winnerVariantId = results.recommendation.leadingVariantId;
        }
      }

      await stopExperimentWithWinner(experiment, {
        winnerVariantId,
        promoteToFlag: false,
        userId: "system",
        ipAddress: null,
        userAgent: null,
      });

      await invalidateExperimentCache(experiment.projectId);
      stopped += 1;
    } catch (err) {
      log.error("scheduled stop failed, releasing claim for retry", {
        experimentId: candidate.id,
        err: err instanceof Error ? err.message : String(err),
      });
      // Release the claim: restore the scheduledEndAt the claim cleared so
      // the next sweep sees this row as due again rather than never.
      await drizzle.experimentRepo.updateExperiment(drizzle.db, claimed.id, {
        scheduledEndAt: candidate.scheduledEndAt,
      });
      skipped += 1;
    }
  }

  return { stopped, skipped };
}

export async function runExperimentSchedulerSweep(
  now: Date = new Date(),
): Promise<ExperimentSchedulerSweepResult> {
  const starts = await sweepStarts(now);
  const stops = await sweepStops(now);

  const result: ExperimentSchedulerSweepResult = {
    started: starts.started,
    stopped: stops.stopped,
    skipped: starts.skipped + stops.skipped,
  };

  if (result.started > 0 || result.stopped > 0) {
    log.info("experiment scheduler sweep", { ...result });
  }
  return result;
}

// =============================================================
// BullMQ queue + worker + scheduling
// =============================================================

let cachedQueue: Queue | undefined;

export function getExperimentSchedulerQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(EXPERIMENT_SCHEDULER_QUEUE_NAME, {
    connection: createBullConnection("experiment-scheduler"),
    defaultJobOptions: {
      removeOnComplete: { count: 30, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 30 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

/**
 * Registers the repeatable sweep job. Safe to call multiple times on
 * boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function scheduleExperimentScheduler(): Promise<void> {
  const queue = getExperimentSchedulerQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: EXPERIMENT_SCHEDULER_SWEEP_INTERVAL_MS },
    },
  );
  log.info("experiment scheduler sweep registered", {
    everyMs: EXPERIMENT_SCHEDULER_SWEEP_INTERVAL_MS,
  });
}

let cachedWorker: Worker | undefined;

export function createExperimentSchedulerWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    EXPERIMENT_SCHEDULER_QUEUE_NAME,
    async (_job: Job) => {
      return runExperimentSchedulerSweep();
    },
    {
      connection: createBullConnection("experiment-scheduler"),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("experiment scheduler sweep job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  return cachedWorker;
}
