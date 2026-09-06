import { Queue, type JobsOptions } from "bullmq";
import { createBullConnection } from "../lib/redis";

// =============================================================
// dsar queue — contract + BullMQ producer (ROADMAP §9.1, Task 3)
// =============================================================
//
// One queue, two job NAMEs — mirrors queues/imports.ts's
// IMPORT_RUN_JOB_NAME / IMPORT_DRY_RUN_JOB_NAME split on a single queue:
// an EXPORT ask and an ERASURE ask are two phases of the same
// subject-access-request lifecycle (one `dsar_requests` row each), not
// two independent systems, so Task 4 (the export worker) and Task 5
// (the erasure worker) both attach a `Worker` to THIS SAME queue name
// and dispatch on job NAME, exactly like `workers/import-runner.ts`'s
// `createImportRunnerWorker` does for its two job names.
//
// This module owns the actual `new Queue(...)` instance and IS the
// producer (`enqueueDsarJob` is the only function that ever calls
// `.add()`) — following queues/notifier.ts's precedent of a queues/*.ts
// module owning its own BullMQ factory, rather than queues/imports.ts's
// (whose factory lives in the worker file), because there is no DSAR
// worker file yet for either job name to hang it off of. Tasks 4/5
// should import `DSAR_QUEUE_NAME` (and, if useful, `DSAR_EXPORT_JOB_NAME`
// / `DSAR_ERASURE_JOB_NAME` / `DsarJobData`) from here rather than
// re-declaring any of this.

export const DSAR_QUEUE_NAME = "rovenue-dsar";

export const DSAR_EXPORT_JOB_NAME = "dsar:export";
export const DSAR_ERASURE_JOB_NAME = "dsar:erasure";

/**
 * Job data for both job names.
 *
 * `type` mirrors `dsarRequestType`'s enum values
 * (packages/db/src/drizzle/enums.ts: `["EXPORT", "ERASURE"]`) as a
 * literal union rather than an imported type — apps/api must not reach
 * into packages/db/src directly (see git history: TS6059 fallout from
 * doing exactly that in tests), and the two literal values here are
 * already the exact strings Drizzle stores for this column, so there is
 * nothing to keep in sync beyond this comment.
 */
export interface DsarJobData {
  dsarRequestId: string;
  projectId: string;
  subscriberId: string;
  type: "EXPORT" | "ERASURE";
}

const DSAR_JOB_ATTEMPTS = 5;
const DSAR_JOB_BACKOFF_MS = 30_000;

const DSAR_JOB_OPTIONS: JobsOptions = {
  attempts: DSAR_JOB_ATTEMPTS,
  backoff: { type: "exponential", delay: DSAR_JOB_BACKOFF_MS },
  removeOnComplete: { age: 30 * 86_400, count: 1_000 },
  removeOnFail: { age: 90 * 86_400 },
};

let cachedQueue: Queue<DsarJobData> | undefined;

export function getDsarQueue(): Queue<DsarJobData> {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue<DsarJobData>(DSAR_QUEUE_NAME, {
    connection: createBullConnection("dsar"),
    defaultJobOptions: DSAR_JOB_OPTIONS,
  });
  return cachedQueue;
}

/**
 * Enqueues exactly one job for one `dsar_requests` row.
 *
 * `jobId` is pinned to the row's own id. This is safe here in a way it
 * is NOT for `import_jobs` (see `workers/import-runner.ts`'s
 * `enqueueImportJob` comment for why THAT queue deliberately does not
 * pin a jobId): a `dsar_requests` row is created once and enqueued
 * once — the database's partial unique index
 * (`dsar_requests_open_subscriber_type_uniq`) stops a second PENDING
 * row from ever existing for the same (subscriberId, type), so there is
 * no "resume/retry against the same row id" flow that pinning could
 * ever collide with. It exists as a second, belt-and-suspenders guard
 * against a route bug that calls this twice for the same row — never
 * relied on as the ONLY idempotency guarantee (that is the database
 * constraint plus the route's own findOpenDsarRequest check).
 */
export async function enqueueDsarJob(
  jobName: typeof DSAR_EXPORT_JOB_NAME | typeof DSAR_ERASURE_JOB_NAME,
  data: DsarJobData,
): Promise<void> {
  const queue = getDsarQueue();
  await queue.add(jobName, data, { ...DSAR_JOB_OPTIONS, jobId: data.dsarRequestId });
}
