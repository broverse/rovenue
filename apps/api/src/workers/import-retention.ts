import { Queue, Worker, type Job } from "bullmq";
import { createBullConnection } from "../lib/redis";
import { drizzle } from "@rovenue/db";
import { IMPORT_FILE_RETENTION_DAYS } from "@rovenue/shared";
import * as importStore from "../lib/import-store";
import { logger } from "../lib/logger";

// =============================================================
// import_jobs file retention sweeper (Task 8, controller Ruling 7)
// =============================================================
//
// Uploaded import files (and their generated NDJSON reports) are
// end-user PII — a customer's RevenueCat/Adapty export — sitting in the
// dedicated private import bucket (lib/import-store.ts). Until this
// worker existed, `IMPORT_FILE_RETENTION_DAYS` was a promise with no
// mechanism: nothing ever deleted them.
//
// Mirrors workers/webhook-retention.ts's shape exactly (own Queue, own
// Worker, own nightly repeatable job — "no shared factory").
//
// Only a job's OWN files are ever touched, and only once the job has
// been terminal (COMPLETED/FAILED/CANCELLED) for longer than the
// retention window — a job that is still RUNNING (or has never
// finished) is never eligible regardless of age; see
// `listImportJobsEligibleForFileRetention`'s doc comment for why a null
// `finishedAt` is a reliable "not done yet" signal, not a data gap.

const log = logger.child("import-retention");

export const IMPORT_RETENTION_QUEUE_NAME = "rovenue-import-retention";

const RETENTION_WINDOW_MS = IMPORT_FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000; // nightly
const REPEATABLE_JOB_NAME = "import:retention";
const REPEATABLE_JOB_ID = "import-retention-repeatable";

// Fix round 1, FIX 6: hoisted out of getImportRetentionQueue's inline
// object literal, matching this file's own RETENTION_WINDOW_MS /
// REPEAT_EVERY_MS convention.
const JOB_RETENTION_KEEP_COUNT = 30;
const FAILED_JOB_RETENTION_KEEP_COUNT = 100;
const JOB_RETENTION_KEEP_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface ImportRetentionResult {
  /** Number of import_jobs rows whose files were swept this run. */
  deletedJobs: number;
  /** Number of individual objects deleted (source file + the dry-run
   *  report, when the job has one, + every Phase-A writer report part). */
  deletedFiles: number;
  cutoff: string; // ISO8601, for log inspection
}

export async function runImportRetention(
  now: Date = new Date(),
): Promise<ImportRetentionResult> {
  const cutoff = new Date(now.getTime() - RETENTION_WINDOW_MS);
  const jobs = await drizzle.importJobRepo.listImportJobsEligibleForFileRetention(
    drizzle.db,
    cutoff,
  );

  let deletedFiles = 0;
  for (const job of jobs) {
    await importStore.deleteObject(job.storageKey);
    deletedFiles += 1;
    if (job.reportStorageKey) {
      await importStore.deleteObject(job.reportStorageKey);
      deletedFiles += 1;
    }
    // Fix round 1, FIX 5: the Phase-A writer's report is one or more
    // numbered PARTS, not the single `reportStorageKey` object above —
    // every part this job ever wrote needs its own delete call.
    for (let partNumber = 1; partNumber <= job.reportPartCount; partNumber++) {
      await importStore.deleteObject(
        importStore.buildReportPartStorageKey(job.projectId, job.id, partNumber),
      );
      deletedFiles += 1;
    }
    // Fix round 1, FIX 3: mark this job's files handled so it drops out
    // of `listImportJobsEligibleForFileRetention` on every future run —
    // without this, the eligible set only ever grows.
    await drizzle.importJobRepo.markImportJobFilesDeleted(drizzle.db, job.id, now);
  }

  log.info("import file retention sweep complete", {
    deletedJobs: jobs.length,
    deletedFiles,
    cutoff: cutoff.toISOString(),
  });
  return { deletedJobs: jobs.length, deletedFiles, cutoff: cutoff.toISOString() };
}

let cachedQueue: Queue | undefined;

export function getImportRetentionQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(IMPORT_RETENTION_QUEUE_NAME, {
    connection: createBullConnection("import-retention"),
    defaultJobOptions: {
      removeOnComplete: {
        count: JOB_RETENTION_KEEP_COUNT,
        age: JOB_RETENTION_KEEP_AGE_SECONDS,
      },
      removeOnFail: {
        count: FAILED_JOB_RETENTION_KEEP_COUNT,
        age: JOB_RETENTION_KEEP_AGE_SECONDS,
      },
    },
  });
  return cachedQueue;
}

/**
 * Register the nightly repeatable job. Safe to call multiple times on
 * boot — BullMQ upserts on {name, jobId, pattern}.
 */
export async function scheduleImportRetention(): Promise<void> {
  const queue = getImportRetentionQueue();
  await queue.add(
    REPEATABLE_JOB_NAME,
    {},
    {
      jobId: REPEATABLE_JOB_ID,
      repeat: { every: REPEAT_EVERY_MS },
    },
  );
  log.info("scheduled import file retention", { everyMs: REPEAT_EVERY_MS });
}

let cachedWorker: Worker | undefined;

export function createImportRetentionWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    IMPORT_RETENTION_QUEUE_NAME,
    async (_job: Job) => {
      return runImportRetention();
    },
    {
      connection: createBullConnection("import-retention"),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("import retention job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("import retention job completed", { jobId: job.id });
  });

  log.info("import retention worker started", {
    queue: IMPORT_RETENTION_QUEUE_NAME,
  });
  return cachedWorker;
}
