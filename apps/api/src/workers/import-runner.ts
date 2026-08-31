import { Queue, Worker, type Job } from "bullmq";
import { drizzle, getPool, type Db } from "@rovenue/db";
import { parseCsvStream, type CanonicalField } from "@rovenue/shared";
import { createBullConnection } from "../lib/redis";
import { logger } from "../lib/logger";
import * as importStore from "../lib/import-store";
import { buildCanonicalRow } from "../services/import/plan";
import {
  writeImportBatch,
  auditImportRunCompleted,
  type ImportWriteRow,
  type BatchOutcome,
} from "../services/import/write";
import { IMPORT_OUTCOMES, createReportWriter, type ImportOutcome } from "../services/import/report";
import {
  IMPORT_QUEUE_NAME,
  IMPORT_BATCH_SIZE,
  IMPORT_JOB_OPTIONS,
  buildImportJobOptions,
} from "../queues/imports";

// =============================================================
// Task 8: import worker — checkpointed batches, resume, cancel
// =============================================================
//
// `runImportJob` is the pure, directly-testable body (same split this
// repo already uses for every other scheduled worker — see
// `runWebhookRetention` / `runFunnelAbandonerSweep`): it does not touch
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
//      the whole file is done — never per batch (see write.ts's rule 4).
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
// dedicated connection checked out from the pool for the duration —
// Drizzle's pooled `db` hands out a different underlying connection per
// query, which would silently drop the lock the moment the "locking"
// connection went back to the pool.
//
// A real `kill -9` of the worker process never runs the `finally` below,
// but that is fine: Postgres releases every advisory lock a session held
// the moment that session's connection closes, which happens as soon as
// the OS notices the process is gone.
const IMPORT_PROJECT_LOCK_PREFIX = "import:project:";

async function withProjectImportLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = `${IMPORT_PROJECT_LOCK_PREFIX}${projectId}`;
  const client = await getPool().connect();
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

export type ImportRunStatus = "COMPLETED" | "CANCELLED";

export interface ImportRunResult {
  jobId: string;
  status: ImportRunStatus;
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
   *  `runWebhookRetention(now)` uses for its cutoff. */
  batchSize?: number;
}

function emptyOutcomeTotals(): Record<ImportOutcome, number> {
  return Object.fromEntries(IMPORT_OUTCOMES.map((o) => [o, 0])) as Record<
    ImportOutcome,
    number
  >;
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

  return withProjectImportLock(projectId, () =>
    processImportJob(db, jobId, projectId, batchSize),
  );
}

async function processImportJob(
  db: Db,
  jobId: string,
  projectId: string,
  batchSize: number,
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
  const reportWriter = createReportWriter(projectId, jobId);
  const totals = emptyOutcomeTotals();
  let checkpointLine = checkpointAtStart;
  let cancelled = false;

  try {
    const objectStream = await importStore.getObject(job.storageKey);
    let header: string[] = [];
    let batch: ImportWriteRow[] = [];

    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return;
      const outcome: BatchOutcome = await writeImportBatch(jobId, batch);
      for (const row of outcome.reportRows) {
        await reportWriter.writeReportRow(row);
      }
      for (const key of IMPORT_OUTCOMES) {
        totals[key] += outcome.outcomes[key];
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

    const reportStorageKey = await reportWriter.finalizeReport();

    if (cancelled) {
      logger.info("import job cancelled mid-run", { jobId, checkpointLine });
      return { jobId, status: "CANCELLED", outcomes: totals, checkpointLine };
    }

    await drizzle.importJobRepo.setImportJobStatus(db, projectId, jobId, {
      status: "COMPLETED",
      reportStorageKey,
      finishedAt: new Date(),
    });
    await auditImportRunCompleted(jobId, totals);
    return { jobId, status: "COMPLETED", outcomes: totals, checkpointLine };
  } catch (err) {
    // Close the report stream so a crash mid-run doesn't leave the
    // underlying multipart upload open indefinitely — the report itself
    // is incomplete/discardable on a FAILED run (the next attempt opens
    // a fresh one), but the upload resource still needs to be released.
    await reportWriter.finalizeReport().catch(() => undefined);
    await drizzle.importJobRepo
      .setImportJobStatus(db, projectId, jobId, {
        status: "FAILED",
        errorMessage: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
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

/** Enqueues (or re-enqueues, e.g. after a cancel) one import job's run. */
export async function enqueueImportJob(importJobId: string): Promise<void> {
  const queue = getImportQueue();
  await queue.add(
    "import:run",
    { importJobId },
    buildImportJobOptions(importJobId),
  );
}

/** BullMQ worker concurrency — the number of DIFFERENT projects' import
 *  jobs this process may run at once. Per-project serialisation is a
 *  separate axis (IMPORT_JOB_CONCURRENCY_PER_PROJECT, enforced by the
 *  advisory lock above), so this can safely be > 1. */
const WORKER_CONCURRENCY = 5;

let cachedWorker: Worker<ImportRunJobData> | undefined;

export function createImportRunnerWorker(): Worker<ImportRunJobData> {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker<ImportRunJobData>(
    IMPORT_QUEUE_NAME,
    async (job: Job<ImportRunJobData>) => {
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
