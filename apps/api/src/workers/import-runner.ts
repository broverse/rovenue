import { Queue, Worker, type Job } from "bullmq";
import type { Pool } from "pg";
import { drizzle, createPool, type Db } from "@rovenue/db";
import { parseCsvStream, type CanonicalField } from "@rovenue/shared";
import { createBullConnection } from "../lib/redis";
import { logger } from "../lib/logger";
import * as importStore from "../lib/import-store";
import { buildCanonicalRow, planImport } from "../services/import/plan";
import {
  writeImportBatch,
  auditImportRunCompleted,
  type ImportWriteRow,
  type BatchOutcome,
} from "../services/import/write";
import { createReportWriter, type ImportOutcome, type ReportWriter } from "../services/import/report";
import { verifyImportedAnchors, type ImportVerifyDeps } from "../services/import/verify";
import { createProductionImportVerifyDeps } from "../services/import/verify-store-clients";
import {
  IMPORT_QUEUE_NAME,
  IMPORT_RUN_JOB_NAME,
  IMPORT_DRY_RUN_JOB_NAME,
  IMPORT_BATCH_SIZE,
  IMPORT_JOB_OPTIONS,
  buildImportJobOptions,
  buildImportDryRunJobOptions,
} from "../queues/imports";

// =============================================================
// Task 8: import worker — checkpointed batches, resume, cancel
// =============================================================
//
// `runImportJob` is the pure, directly-testable body (same split this
// repo already uses for every other scheduled worker — see
// `runImportRetention` / `runFunnelAbandonerSweep`): it does not touch
// BullMQ at all, so tests exercise it by calling it directly against a
// real Postgres, the same way services/import/write.ts's own tests do.
// `createImportRunnerWorker` is the thin BullMQ wrapper around it.
//
// Correctness invariants this file owns (task-8 controller context):
//
//   1. Replay whole batches, never partial rows. The checkpoint
//      (`saveImportJobCheckpoint`) only ever advances to
//      `outcome.lastLineNumber` AFTER `writeImportBatch` has fully
//      returned for that batch. A crash mid-batch (this process killed,
//      the object-storage read dying mid-stream, a DB error partway
//      through the batch's rows) never advances the checkpoint, so on
//      resume the ENTIRE batch — including whatever rows it already
//      wrote — is replayed from `writeImportBatch`. That is safe only
//      because every write inside it (purchase upsert, revenue-event
//      dedupe key, syncAccess) is independently idempotent; this file
//      never processes a batch at row granularity, exactly so that
//      reasoning keeps holding.
//   2. `auditImportRunCompleted` is called exactly once per run, when
//      the whole file is done — never per batch (see write.ts's rule 4)
//      — and (fix round 1, FIX 1) with the job's PERSISTED, cumulative
//      `counters`, never a call-scoped accumulator. A job that spans
//      more than one `runImportJob` invocation (exactly the
//      crash-resume and cancel-resume paths this task exists for) would
//      otherwise audit only the LAST invocation's contribution into an
//      append-only, hash-chained log — permanently and silently wrong.
//   3. Partition provisioning: `writeImportBatch` itself provisions the
//      `revenue_events` partitions a batch's rows need, BEFORE that
//      batch performs its first write (Task 8a, called from inside
//      write.ts). This file just needs to call `writeImportBatch` once
//      per batch — the "fail cleanly before the first write" guarantee
//      is already batch-scoped there, and the replay model above means a
//      later batch's provisioning failure is just an ordinary batch
//      failure that resume already handles.
//   4. Two jobs for the SAME project never run concurrently
//      (IMPORT_JOB_CONCURRENCY_PER_PROJECT = 1) — enforced below by a
//      blocking Postgres session advisory lock, not by BullMQ (which has
//      no per-key group concurrency in its open-source edition).
//   5. A crash-and-resume must never destroy the only record of why a
//      row was skipped (fix round 1, FIX 5). Each invocation that does
//      real work writes its own numbered report PART
//      (`buildReportPartStorageKey`) instead of every attempt fighting
//      over one shared, overwritable key — see `ensureReportWriter`.
//   6. Task 9: Phase B (store re-validation, services/import/verify.ts)
//      runs as a SECOND phase of this SAME job, immediately after Phase A
//      reaches VERIFYING (Task 10 fix round 2, FIX A — Phase A used to
//      write COMPLETED here, which left a hard-crash-during-Phase-B run
//      permanently stuck: the top guard below treats COMPLETED as
//      nothing-left-to-do, so a retry never re-entered Phase B and the
//      completion audit never fired) — never as a separate job, never
//      invoked from anywhere else. From there it settles at COMPLETED
//      (verification fully resolved, only after Phase A's own writes
//      already succeeded — this is also where `finishedAt` is finally
//      set, fix round 2, FIX A), VERIFICATION_INCOMPLETE (anchors still
//      pending after its retry/give-up budget — fix round 1, FIX 4), or
//      CANCELLED (an operator cancelled the job while Phase B was running
//      — also FIX 4). A Phase B crash is caught separately so it can
//      never relabel a successful import as FAILED — a VERIFYING row is
//      recoverable by a later retry or an operator's `/resume`, the exact
//      same paths a VERIFICATION_INCOMPLETE row already used.

/** BullMQ worker concurrency — the number of DIFFERENT projects' import
 *  jobs this process may run at once. Per-project serialisation is a
 *  separate axis (IMPORT_JOB_CONCURRENCY_PER_PROJECT, enforced by the
 *  advisory lock below), so this can safely be > 1. Declared up top
 *  because the lock pool below is sized from it. */
const WORKER_CONCURRENCY = 5;

// ---------------------------------------------------------------
// Per-project mutex
// ---------------------------------------------------------------
//
// `packages/db/src/drizzle/repositories/locks.ts`'s advisory-lock
// wrappers are transaction-scoped (`pg_advisory_xact_lock`, released at
// COMMIT/ROLLBACK) — unsuitable here because a whole import run is NOT
// one transaction (rule 1 above: it is many independent batch writes).
// This lock needs to be held for the run's entire wall-clock duration
// and released deterministically when it ends, so it uses the SESSION
// variant (`pg_advisory_lock` / `pg_advisory_unlock`) on a single
// dedicated connection checked out for the duration — Drizzle's pooled
// `db` hands out a different underlying connection per query, which
// would silently drop the lock the moment the "locking" connection went
// back to the pool.
//
// A real `kill -9` of the worker process never runs the `finally` below,
// but that is fine: Postgres releases every advisory lock a session held
// the moment that session's connection closes, which happens as soon as
// the OS notices the process is gone.
//
// Fix round 1, FIX 4: that dedicated connection must NOT come from
// `getPool()` — the shared pool the whole API process uses for every
// other query (default `max: 10`). An import run can hold its lock
// connection for hours; `WORKER_CONCURRENCY` concurrent imports would
// each permanently park one of those 10 connections, starving unrelated
// API request traffic long before any import finishes. This module owns
// a SEPARATE, small, dedicated pool instead, sized from
// `WORKER_CONCURRENCY` (the max number of import runs this process's
// BullMQ worker drives at once) plus a little headroom for callers
// outside the worker (a direct `runImportJob` call, tests). If this pool
// is ever exhausted — more concurrent `runImportJob` calls than it has
// connections for — `.connect()` queues and then REJECTS after
// `createPool`'s default `connectionTimeoutMillis` (5s) rather than
// hanging forever; the run fails with that error and BullMQ retries it
// under the queue's normal backoff. The shared pool is never touched
// either way.
const IMPORT_LOCK_POOL_SIZE = WORKER_CONCURRENCY + 2;

let cachedLockPool: Pool | undefined;

function getImportLockPool(): Pool {
  if (!cachedLockPool) {
    cachedLockPool = createPool({ max: IMPORT_LOCK_POOL_SIZE });
  }
  return cachedLockPool;
}

const IMPORT_PROJECT_LOCK_PREFIX = "import:project:";

async function withProjectImportLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = `${IMPORT_PROJECT_LOCK_PREFIX}${projectId}`;
  const client = await getImportLockPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      lockKey,
    ]);
    return await fn();
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [lockKey],
      );
    } finally {
      client.release();
    }
  }
}

// ---------------------------------------------------------------
// runImportJob
// ---------------------------------------------------------------

// Task 9: `VERIFICATION_INCOMPLETE` is Phase B's outcome, never Phase A's —
// it can only replace a Phase-A `COMPLETED` result, after Phase A's own
// writes have already succeeded (see the call site below).
export type ImportRunStatus = "COMPLETED" | "CANCELLED" | "VERIFICATION_INCOMPLETE";

export interface ImportRunResult {
  jobId: string;
  status: ImportRunStatus;
  /** The job's full, PERSISTED, cumulative outcome breakdown — not just
   *  this invocation's contribution (fix round 1, FIX 1). Read straight
   *  from `import_jobs.counters` after the final checkpoint. */
  outcomes: Record<ImportOutcome, number>;
  /** Highest source line number checkpointed by the time this call
   *  returned — equal to the file's last line on COMPLETED, or the last
   *  fully-written batch's line on CANCELLED. */
  checkpointLine: number;
}

export interface RunImportJobOptions {
  /** Override for testing only — production callers always get
   *  IMPORT_BATCH_SIZE. Exists so a test can force several small batches
   *  (to observe checkpoint/cancel behaviour) without waiting on
   *  hundreds of real rows, the same "inject a smaller unit" seam
   *  `runImportRetention(now)` uses for its cutoff. */
  batchSize?: number;
  /** Override for testing only — production callers always get
   *  `createProductionImportVerifyDeps()`. Exists so a test whose subject
   *  is Phase A (batching/checkpoint/cancel/the per-project lock) can
   *  give Phase B a trivial fake and assert on Phase A's own behaviour
   *  without it being reclassified as `VERIFICATION_INCOMPLETE` purely
   *  because the test project has no real store credentials configured.
   *  Task 9's own tests exercise Phase B directly via
   *  `verifyImportedAnchors`, not through this seam. */
  verifyDeps?: ImportVerifyDeps;
}

/**
 * Runs (or resumes, or restarts after a cancel) one import job to
 * completion or to the point it is cancelled.
 *
 * Idempotent no-op on a job that is already COMPLETED. Any other status
 * (RUNNING — resuming after a crash; CANCELLED — an operator explicitly
 * re-running; FAILED — retrying) is treated as "keep going from the
 * checkpoint", which is exactly what BullMQ's own retry of a job that
 * threw will do, and what a fresh `enqueueImportJob` call after a cancel
 * does too.
 */
export async function runImportJob(
  jobId: string,
  options: RunImportJobOptions = {},
): Promise<ImportRunResult> {
  const db = drizzle.db;
  const initial = await drizzle.importJobRepo.getImportJobById(db, jobId);
  if (!initial) {
    throw new Error(`runImportJob: import job ${jobId} not found`);
  }
  const projectId = initial.projectId;
  const batchSize = options.batchSize ?? IMPORT_BATCH_SIZE;
  const verifyDeps = options.verifyDeps ?? createProductionImportVerifyDeps();

  return withProjectImportLock(projectId, () =>
    processImportJob(db, jobId, projectId, batchSize, verifyDeps),
  );
}

async function processImportJob(
  db: Db,
  jobId: string,
  projectId: string,
  batchSize: number,
  verifyDeps: ImportVerifyDeps,
): Promise<ImportRunResult> {
  let job = await drizzle.importJobRepo.getImportJobById(db, jobId);
  if (!job) {
    throw new Error(`runImportJob: import job ${jobId} not found`);
  }

  if (job.status === "COMPLETED") {
    return {
      jobId,
      status: "COMPLETED",
      outcomes: (job.counters ?? {}) as Record<ImportOutcome, number>,
      checkpointLine: job.checkpointLine,
    };
  }

  job = await drizzle.importJobRepo.setImportJobStatus(db, projectId, jobId, {
    status: "RUNNING",
    startedAt: job.startedAt ?? new Date(),
  });

  const mapping = job.mapping as Record<string, CanonicalField>;
  const checkpointAtStart = job.checkpointLine;
  const reportPartCountAtStart = job.reportPartCount;
  let checkpointLine = checkpointAtStart;
  let cancelled = false;

  // Fix round 1, FIX 5: lazily opened on the FIRST batch this invocation
  // actually writes, as its own numbered part — never the single shared
  // key every earlier attempt used to fight over. An invocation that
  // turns out to have nothing left to do never allocates a part it
  // would leave empty.
  //
  // Held as properties on one object, not two bare `let`s, because a
  // bare outer `let` reassigned inside a nested function (`ensureReportWriter`
  // below) hits a real TypeScript control-flow-narrowing limitation:
  // every later `if (reportWriter)` check in this function resolves to
  // `never` instead of `ReportWriter` (reproduced in isolation; not
  // specific to this codebase). Property access on an object sidesteps
  // it.
  const reportState: { writer: ReportWriter | null; partNumber: number | null } = {
    writer: null,
    partNumber: null,
  };

  function ensureReportWriter(): ReportWriter {
    if (!reportState.writer) {
      reportState.partNumber = reportPartCountAtStart + 1;
      reportState.writer = createReportWriter(projectId, jobId, reportState.partNumber);
    }
    return reportState.writer;
  }

  try {
    const objectStream = await importStore.getObject(job.storageKey);
    let header: string[] = [];
    let batch: ImportWriteRow[] = [];

    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return;
      const outcome: BatchOutcome = await writeImportBatch(jobId, batch);
      const writer = ensureReportWriter();
      for (const row of outcome.reportRows) {
        await writer.writeReportRow(row);
      }
      await drizzle.importJobRepo.incrementImportJobCounters(
        db,
        projectId,
        jobId,
        outcome.outcomes,
      );
      const updated = await drizzle.importJobRepo.saveImportJobCheckpoint(
        db,
        projectId,
        jobId,
        outcome.lastLineNumber,
      );
      checkpointLine = updated.checkpointLine;
      batch = [];

      // Cancellation is checked at batch BOUNDARIES only, never inside
      // writeImportBatch — consistent with rule 1: a batch either runs
      // to completion or is entirely re-run later, so there is no
      // meaningful way to "cancel" partway through one anyway.
      const fresh = await drizzle.importJobRepo.getImportJob(db, projectId, jobId);
      if (fresh?.status === "CANCELLED") cancelled = true;
    };

    for await (const event of parseCsvStream(objectStream)) {
      if ("header" in event) {
        header = event.header;
        continue;
      }
      if (event.lineNumber <= checkpointAtStart) {
        // Already covered by an earlier, fully-committed batch.
        continue;
      }
      const canonicalRow = buildCanonicalRow(header, event.row, mapping);
      batch.push({ lineNumber: event.lineNumber, row: canonicalRow });
      if (batch.length >= batchSize) {
        await flushBatch();
        if (cancelled) break;
      }
    }
    if (!cancelled) {
      await flushBatch();
    }

    // Close THIS attempt's report part (if one was opened) and work out
    // the new cumulative part count. A run that did nothing this
    // invocation (e.g. resuming a job whose checkpoint already covers
    // the whole file) leaves the count untouched.
    let finalReportPartCount = reportPartCountAtStart;
    if (reportState.writer) {
      await reportState.writer.finalizeReport();
      finalReportPartCount = reportState.partNumber!;
    }

    if (cancelled) {
      const persisted = await drizzle.importJobRepo.setImportJobStatus(db, projectId, jobId, {
        status: "CANCELLED",
        reportPartCount: finalReportPartCount,
      });
      logger.info("import job cancelled mid-run", { jobId, checkpointLine });
      return {
        jobId,
        status: "CANCELLED",
        outcomes: (persisted.counters ?? {}) as Record<ImportOutcome, number>,
        checkpointLine,
      };
    }

    // Task 10 fix round 2 (FIX A): VERIFYING, not COMPLETED, and no
    // `finishedAt` — the run is NOT finished yet, Phase B is about to
    // start. Before this fix, this write said COMPLETED and stayed that
    // way for Phase B's ENTIRE duration (each anchor group can involve
    // external Apple/Google/Stripe calls with retry and backoff, so this
    // can be a long window) — a HARD crash in that window (OOM, a deploy
    // restart, `kill -9`, never a catchable JS exception) left the row
    // reading COMPLETED with verification silently abandoned: the guard
    // at the top of this function treats COMPLETED as "nothing left to
    // do", so a retry never re-entered Phase B, and the audit below never
    // fired at all. VERIFYING is never that guard's skip-status, so a
    // crash-interrupted run resumes exactly like a VERIFICATION_INCOMPLETE
    // one does — Phase A fast-forwards its checkpoint as a no-op (this
    // very write, re-run, is idempotent) and Phase B resumes off
    // `purchases.verifiedAt`.
    const verifyingJob = await drizzle.importJobRepo.setImportJobStatus(db, projectId, jobId, {
      status: "VERIFYING",
      reportPartCount: finalReportPartCount,
    });
    // FIX 1: audit from the PERSISTED, cumulative counters (see rule 2
    // above) — never a call-scoped accumulator, which would report only
    // this invocation's slice on any job that took more than one call
    // to finish.
    const finalOutcomes = (verifyingJob.counters ?? {}) as Record<ImportOutcome, number>;

    // Task 9, Phase B: store re-validation runs as a SECOND phase of this
    // SAME job, after Phase A's writes (above) have already succeeded.
    // `verifyImportedAnchors` persists its own counters and status:
    // COMPLETED (verification fully resolved, INCLUDING a resumed call
    // clearing an earlier VERIFICATION_INCOMPLETE — fix round 1, minor 1;
    // this is also where `finishedAt` finally gets set — fix round 2, FIX
    // A), VERIFICATION_INCOMPLETE (anchors still pending after this
    // call's retry/give-up budget), or CANCELLED (an operator cancelled
    // the job while this call was running — fix round 1, FIX 4). A crash
    // or thrown error HERE must never relabel Phase A's already-successful
    // import as FAILED (the catch block below would do exactly that), so
    // it gets its own try/catch: the worst a broken verifier can do is
    // leave the job resumable at VERIFICATION_INCOMPLETE, which a later
    // `verifyImportedAnchors` call (this function, called again) can
    // always retry — every anchor it already resolved is skipped via the
    // `verifiedAt` checkpoint (see verify.ts).
    let finalStatus: ImportRunStatus = "COMPLETED";
    try {
      const verifySummary = await verifyImportedAnchors(jobId, verifyDeps);
      if (verifySummary.status !== "COMPLETED") {
        finalStatus = verifySummary.status;
      }
    } catch (verifyErr) {
      logger.error(
        "import job: phase B store re-validation crashed (Phase A's own writes already succeeded)",
        {
          jobId,
          err: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
        },
      );
      finalStatus = "VERIFICATION_INCOMPLETE";
      await drizzle.importJobRepo
        .setImportJobStatus(db, projectId, jobId, { status: "VERIFICATION_INCOMPLETE" })
        .catch(() => undefined);
    }

    // Task 10 fix round 1 (FIX 3): audited AFTER Phase B has settled, with
    // the run's TRUE final status — never unconditionally "COMPLETED".
    // Before this fix, the call sat right after Phase A's own COMPLETED
    // write (above), so a run that Phase B then downgraded to
    // VERIFICATION_INCOMPLETE (or, in principle, CANCELLED) still
    // permanently audited COMPLETED into the append-only, hash-chained
    // log. `outcomes` is unchanged (Phase A's own buckets); only the
    // `status` field embedded in the payload needed to become honest.
    await auditImportRunCompleted(jobId, finalOutcomes, finalStatus);

    return { jobId, status: finalStatus, outcomes: finalOutcomes, checkpointLine };
  } catch (err) {
    // Close the report stream so a crash mid-run doesn't leave the
    // underlying multipart upload open indefinitely — the part's rows
    // written so far are usable (unlike the pre-fix single-key design,
    // a part is never overwritten by the next attempt), so it's worth
    // finalizing rather than discarding.
    let finalReportPartCount: number | undefined;
    if (reportState.writer) {
      await reportState.writer.finalizeReport().catch(() => undefined);
      finalReportPartCount = reportState.partNumber!;
    }
    await drizzle.importJobRepo
      .setImportJobStatus(db, projectId, jobId, {
        status: "FAILED",
        errorMessage: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
        ...(finalReportPartCount !== undefined
          ? { reportPartCount: finalReportPartCount }
          : {}),
      })
      .catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------
// BullMQ queue + worker
// ---------------------------------------------------------------

export interface ImportRunJobData {
  importJobId: string;
}

let cachedQueue: Queue<ImportRunJobData> | undefined;

export function getImportQueue(): Queue<ImportRunJobData> {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue<ImportRunJobData>(IMPORT_QUEUE_NAME, {
    connection: createBullConnection("import-runner"),
    defaultJobOptions: IMPORT_JOB_OPTIONS,
  });
  return cachedQueue;
}

/**
 * Enqueues (or re-enqueues, e.g. after a cancel or a `/resume`) one
 * import job's run. Final-fix-wave FIX 1: each call is now a genuinely
 * distinct BullMQ job (see `buildImportJobOptions`'s comment) — a
 * retained completed/failed job from an earlier attempt can no longer
 * silently swallow this one.
 */
export async function enqueueImportJob(importJobId: string): Promise<void> {
  const queue = getImportQueue();
  await queue.add(IMPORT_RUN_JOB_NAME, { importJobId }, buildImportJobOptions());
}

/**
 * Task 10 fix round 1 (FIX 2): enqueues a dry-run-only scan on the SAME
 * queue as a commit run, distinguished by BullMQ job NAME
 * (`IMPORT_DRY_RUN_JOB_NAME`) — see `createImportRunnerWorker`'s dispatch
 * below and `buildImportDryRunJobOptions`'s own comment for why this
 * needs its own (single-attempt) job options rather than reusing
 * `buildImportJobOptions`.
 *
 * Final-fix-wave FIX 1: no longer pins a `jobId` — see
 * `buildImportDryRunJobOptions`'s comment. Duplicate concurrent scans
 * stay prevented by the route's own status-gate 409 ("a second dry-run
 * request while DRY_RUN_RUNNING must not start a second scan"), not by
 * BullMQ id coalescing.
 */
export async function enqueueImportDryRun(importJobId: string): Promise<void> {
  const queue = getImportQueue();
  await queue.add(
    IMPORT_DRY_RUN_JOB_NAME,
    { importJobId },
    buildImportDryRunJobOptions(),
  );
}

let cachedWorker: Worker<ImportRunJobData> | undefined;

export function createImportRunnerWorker(): Worker<ImportRunJobData> {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker<ImportRunJobData>(
    IMPORT_QUEUE_NAME,
    async (job: Job<ImportRunJobData>) => {
      // Task 10 fix round 1 (FIX 2): a dry-run job is a single read-only
      // scan (`planImport`) with none of `runImportJob`'s checkpoint/
      // resume/per-project-lock machinery — it doesn't need any of that
      // (no writes to serialize against, no partial-batch state to
      // resume from), so it is dispatched straight to `planImport`
      // rather than through `runImportJob`.
      if (job.name === IMPORT_DRY_RUN_JOB_NAME) {
        return planImport(job.data.importJobId);
      }
      return runImportJob(job.data.importJobId);
    },
    {
      connection: createBullConnection("import-runner"),
      concurrency: WORKER_CONCURRENCY,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    logger.error("import job failed", {
      jobId: job?.id,
      importJobId: job?.data.importJobId,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    logger.debug("import job completed", {
      jobId: job.id,
      importJobId: job.data.importJobId,
    });
  });

  logger.info("import runner worker started", { queue: IMPORT_QUEUE_NAME });
  return cachedWorker;
}
