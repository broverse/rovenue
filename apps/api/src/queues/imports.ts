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
 * BullMQ job NAMEs (not ids) distinguishing a full commit run from a
 * dry-run-only scan — both share the SAME queue/worker
 * (`workers/import-runner.ts`'s `createImportRunnerWorker` dispatches on
 * this), since they are two phases of one job-lifecycle system, not two
 * separate ones. Task 10 fix round 1 (FIX 2): the dry run used to be
 * awaited synchronously inside the dashboard route because no queue
 * existed for it — moved onto this same queue so a 2 GiB file's scan
 * can't run past a proxy/load-balancer idle timeout.
 */
export const IMPORT_RUN_JOB_NAME = "import:run";
export const IMPORT_DRY_RUN_JOB_NAME = "import:dry-run";

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
 * BullMQ job options for one enqueue call.
 *
 * Final-fix-wave FIX 1: this used to pin `jobId` to the import_jobs row's
 * own cuid2 id, reasoning that re-enqueueing the same id (an operator
 * resuming a cancelled run) would "naturally coalesce" with a
 * still-active job. That reasoning missed BullMQ's actual dedup
 * semantics: `addStandardJob`'s Lua checks `EXISTS jobIdKey` and, on a
 * hit, calls `handleDuplicatedJob` — which emits a `duplicated` event and
 * returns the id WITHOUT QUEUEING ANYTHING — for a *completed or failed*
 * job still inside its `removeOnComplete`/`removeOnFail` retention
 * window, not just an active one. With a 7-day completed / 30-day failed
 * retention, `/resume` on `VERIFICATION_INCOMPLETE`, re-running a dry run
 * after a mapping fix, and cancel-then-rerun all deduped against a
 * terminal job and silently ran nothing — `queue.add()` resolves
 * normally, so nothing surfaced. No other enqueue site in this repo pins
 * `jobId`; this was not a pattern worth preserving.
 *
 * Every enqueue is now a genuinely distinct BullMQ job (no `jobId`, so
 * BullMQ assigns its own unique id). The idempotency this system
 * actually needs comes from elsewhere, not from job-id coalescing:
 * `IMPORT_JOB_CONCURRENCY_PER_PROJECT`'s Postgres advisory lock
 * (workers/import-runner.ts) already serializes concurrent runs for one
 * project, and `processImportJob`'s own `status === "COMPLETED"` guard
 * makes a second run over an already-finished job a harmless no-op once
 * that lock is released — so a redundant re-enqueue costs at most one
 * blocked worker slot, never corruption or silence.
 */
export function buildImportJobOptions(): JobsOptions {
  return { ...IMPORT_JOB_OPTIONS };
}

/**
 * Task 10 fix round 1 (FIX 2): job options for a QUEUED dry run.
 *
 * `attempts: 1`, no backoff — deliberately NOT `IMPORT_JOB_OPTIONS`.
 * `planImport` (services/import/plan.ts) is read-only but has none of
 * Phase A/B's checkpoint/resume machinery: a partial attempt cannot be
 * safely continued from where it left off. If it threw partway through
 * (say, after `incrementImportJobCounters` but before the final
 * `DRY_RUN_COMPLETE` status write), a BullMQ auto-retry would re-run the
 * WHOLE scan and additively re-increment those counters on top of the
 * failed attempt's partial contribution — double-counting. A failed dry
 * run instead lands the job at `FAILED` (plan.ts's own catch block),
 * which is dry-run-startable again; the operator's own explicit retry
 * (another `POST .../dry-run`) is what reruns it, never an automatic one.
 *
 * Final-fix-wave FIX 1: no longer pins a `jobId` (see
 * `buildImportJobOptions`'s comment for why that was actively harmful —
 * a re-run of the dry run after a mapping fix used to dedupe against the
 * PREVIOUS completed dry-run job and brick the row for 7 days).
 * Duplicate concurrent scans are already prevented one layer up: the
 * route only calls this from `DRY_RUN_STARTABLE_STATUSES` and
 * synchronously flips the row to `DRY_RUN_RUNNING` before enqueueing, so
 * a second `POST .../dry-run` while one is in flight 409s before it ever
 * reaches here.
 */
export function buildImportDryRunJobOptions(): JobsOptions {
  return {
    attempts: 1,
    removeOnComplete: { age: 7 * 86_400, count: 1_000 },
    removeOnFail: { age: 30 * 86_400 },
  };
}
