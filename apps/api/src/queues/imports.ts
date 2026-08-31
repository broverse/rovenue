import type { JobsOptions } from "bullmq";

// =============================================================
// Data-import queue contracts (Task 8)
// =============================================================
//
// Following queues/integrations.ts's convention: this module holds the
// queue NAME and job-OPTIONS contract only. The actual `new Queue(...)` /
// `new Worker(...)` pair lives in workers/import-runner.ts (and
// workers/import-retention.ts for the retention sweep) — "each worker
// declares its own queue with its own defaultJobOptions; there is no
// shared factory" (repo convention, task-8 controller context).

export const IMPORT_QUEUE_NAME = "rovenue-imports";

/**
 * Rows processed per checkpoint (services/import/write.ts's
 * `writeImportBatch` / workers/import-runner.ts's `runImportJob`).
 *
 * Far smaller than the outbox/webhook batch sizes elsewhere in this repo
 * (outbox-dispatcher.ts: 250, scheduled-actions.ts: 200) because each row
 * here costs several DB round trips of its own (product resolution,
 * subscriber resolution, a purchase upsert, a revenue event, and —once
 * per touched subscriber— a `syncAccess` recompute), not one. A smaller
 * batch also bounds how much work a crash-and-resume has to redo: Task
 * 8's writer replays a WHOLE batch on recovery (never a partial one —
 * see write.ts's module comment), so this number is also the maximum
 * amount of redundant (though idempotent) work one crash can cost.
 */
export const IMPORT_BATCH_SIZE = 500;

/**
 * How many import jobs may run at once for the SAME project.
 *
 * BullMQ's open-source edition has no per-key "group concurrency" (that
 * is a Pro-only feature) — `workers/import-runner.ts` enforces this bound
 * itself, with a blocking Postgres session advisory lock keyed by
 * projectId, held for the whole run. The lock is a plain mutex, so this
 * constant being `1` is not just documentation: raising it would require
 * replacing the mutex with an actual counting semaphore, not just
 * changing this number.
 */
export const IMPORT_JOB_CONCURRENCY_PER_PROJECT = 1;

/**
 * Every import-run enqueue site's job options MINUS `jobId` — this is
 * what `workers/import-runner.ts`'s `getImportQueue()` installs as the
 * queue's own `defaultJobOptions` (repo convention: every worker owns
 * its queue's defaults; there is no shared factory).
 *
 * Backoff is the built-in "exponential" strategy, not a custom one — this
 * repo has already shipped a dead custom-backoff strategy once
 * (queues/integrations.ts's module comment) because BullMQ only consults
 * `settings.backoffStrategy` when a job's own options say
 * `backoff: { type: "custom" }`. The safest way to not repeat that bug is
 * to not need a custom strategy here at all: `runImportJob` resumes from
 * its own checkpoint regardless of how long a retry waited, so the
 * built-in exponential schedule is sufficient.
 */
export const IMPORT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { age: 7 * 86_400, count: 1_000 },
  removeOnFail: { age: 30 * 86_400 },
};

/**
 * BullMQ job options for one enqueue call. `jobId` is the import_jobs
 * row's own cuid2 id — one BullMQ job per import job, so re-enqueueing
 * the same id (e.g. an operator resuming a cancelled run) naturally
 * coalesces with a still-active job under BullMQ's own dedup-by-jobId
 * behaviour, and is directly traceable back to the `import_jobs` row
 * from a queue dashboard.
 */
export function buildImportJobOptions(importJobId: string): JobsOptions {
  return { ...IMPORT_JOB_OPTIONS, jobId: importJobId };
}
