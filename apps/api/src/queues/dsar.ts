import { Queue, type JobsOptions } from "bullmq";
import { createBullConnection } from "../lib/redis";

// =============================================================
// dsar queues — contract + BullMQ producer (ROADMAP §9.1, Tasks 3-5)
// =============================================================
//
// TWO queues, one per job NAME — `DSAR_EXPORT_QUEUE_NAME` for
// `DSAR_EXPORT_JOB_NAME` jobs, `DSAR_ERASURE_QUEUE_NAME` for
// `DSAR_ERASURE_JOB_NAME` jobs. This module originally shipped (Task 3)
// as ONE queue with two job names, mirroring queues/imports.ts's
// IMPORT_RUN_JOB_NAME / IMPORT_DRY_RUN_JOB_NAME split. The controller
// overruled that for Task 4: a BullMQ `Worker` attached to a queue
// consumes EVERY job on it regardless of job name — there is no
// per-name routing at the Worker level — so a single shared queue makes
// a dedicated erasure worker impossible; the only way to run export and
// erasure on separate workers is to give them separate queues. That
// separation matters because it is not cosmetic: erasure carries a
// statutory deadline that export does not, and a backlog of heavy
// multi-table exports must never delay it by sitting in front of it on
// one queue.
//
// This module still owns the actual `new Queue(...)` instances and IS
// the producer (`enqueueDsarJob` is the only function that ever calls
// `.add()`) — following queues/notifier.ts's precedent of a queues/*.ts
// module owning its own BullMQ factory, rather than queues/imports.ts's
// (whose factory lives in the worker file), because Task 4/5's worker
// files need a queue name to attach their `Worker` to before either
// exists on its own. `workers/dsar-export.ts` (Task 4) attaches to
// `DSAR_EXPORT_QUEUE_NAME`; the Task 5 erasure worker attaches to
// `DSAR_ERASURE_QUEUE_NAME`. Neither worker file should re-declare any
// of this — import from here.

export const DSAR_EXPORT_QUEUE_NAME = "rovenue-dsar-export";
export const DSAR_ERASURE_QUEUE_NAME = "rovenue-dsar-erasure";

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

let cachedExportQueue: Queue<DsarJobData> | undefined;
let cachedErasureQueue: Queue<DsarJobData> | undefined;

export function getDsarExportQueue(): Queue<DsarJobData> {
  if (cachedExportQueue) return cachedExportQueue;
  cachedExportQueue = new Queue<DsarJobData>(DSAR_EXPORT_QUEUE_NAME, {
    connection: createBullConnection("dsar-export"),
    defaultJobOptions: DSAR_JOB_OPTIONS,
  });
  return cachedExportQueue;
}

export function getDsarErasureQueue(): Queue<DsarJobData> {
  if (cachedErasureQueue) return cachedErasureQueue;
  cachedErasureQueue = new Queue<DsarJobData>(DSAR_ERASURE_QUEUE_NAME, {
    connection: createBullConnection("dsar-erasure"),
    defaultJobOptions: DSAR_JOB_OPTIONS,
  });
  return cachedErasureQueue;
}

function queueForJobName(
  jobName: typeof DSAR_EXPORT_JOB_NAME | typeof DSAR_ERASURE_JOB_NAME,
): Queue<DsarJobData> {
  return jobName === DSAR_EXPORT_JOB_NAME
    ? getDsarExportQueue()
    : getDsarErasureQueue();
}

/**
 * Enqueues exactly one job for one `dsar_requests` row, onto the queue
 * that matches its job name (see the module doc above for why there are
 * two queues now).
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
  const queue = queueForJobName(jobName);
  await queue.add(jobName, data, { ...DSAR_JOB_OPTIONS, jobId: data.dsarRequestId });
}
