// =============================================================
// imports queue — FIX 1 regression test (final-fix-wave)
// =============================================================
//
// Reproduces the exact bug: `buildImportJobOptions` used to pin BullMQ's
// `jobId` to the import_jobs row's own id, with a `removeOnComplete`
// retention window. BullMQ's `addStandardJob` Lua checks
// `EXISTS jobIdKey` and, on a hit, calls `handleDuplicatedJob` — which
// returns the EXISTING job's id without queueing anything. So
// re-enqueueing after the first attempt completed (exactly what
// `/resume`, a re-run dry run, and cancel-then-rerun all do) silently
// did nothing; `queue.add()` still resolved normally.
//
// This test runs a job to completion on a real BullMQ worker against
// live Redis, then enqueues "the same" import job again and asserts a
// GENUINELY NEW job lands in the queue (not the stale completed one).
// Uses a dedicated, randomly-named test queue — never the production
// `IMPORT_QUEUE_NAME` — so a stray job never mixes with real worker
// traffic.
//
// Requires live Redis (docker-compose host port 6380, same as every
// other *.integration.test.ts in this repo). See final-fix-wave-report.md
// for why this could not be executed in this environment (Docker down).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { buildImportJobOptions, IMPORT_RUN_JOB_NAME } from "./imports";

process.env.REDIS_URL ??= "redis://localhost:6380";
const REDIS_URL = process.env.REDIS_URL!;

const TEST_QUEUE_NAME = `rovenue-imports-test-${createId()}`;

interface TestJobData {
  importJobId: string;
}

let queueConn: Redis;
let workerConn: Redis;
let queue: Queue<TestJobData>;
let worker: Worker<TestJobData>;

beforeAll(async () => {
  queueConn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  workerConn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue<TestJobData>(TEST_QUEUE_NAME, { connection: queueConn });
  // The worker under test does no real import work — it just resolves
  // immediately, so the job reaches "completed" and sits inside
  // buildImportJobOptions()'s removeOnComplete retention window, exactly
  // the state that used to poison a re-enqueue.
  worker = new Worker<TestJobData>(
    TEST_QUEUE_NAME,
    async (_job: Job<TestJobData>) => "ok",
    { connection: workerConn },
  );
  await worker.waitUntilReady();
}, 30_000);

afterAll(async () => {
  await worker.close();
  await queue.close();
  await queueConn.quit();
  await workerConn.quit();
});

function waitForCompleted(jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`job ${jobId} never completed`)),
      15_000,
    );
    worker.on("completed", (job) => {
      if (job.id === jobId) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

describe("import queue re-enqueue (final-fix-wave FIX 1)", () => {
  it("adds a genuinely new job after the previous attempt for the same import job completed", async () => {
    const importJobId = `import-fix1-${createId()}`;

    // First attempt: enqueue and let it run to completion, using the
    // SAME options builder every real call site uses.
    const first = await queue.add(
      IMPORT_RUN_JOB_NAME,
      { importJobId },
      buildImportJobOptions(),
    );
    await waitForCompleted(first.id!);

    // Second attempt — e.g. an operator's `/resume` on the same
    // import_jobs row. Before FIX 1, this called `queue.add()` with the
    // SAME pinned jobId (the import job's own id) and BullMQ silently
    // swallowed it: `handleDuplicatedJob` returned `first.id` again
    // without queueing anything, so this job would never actually run.
    const second = await queue.add(
      IMPORT_RUN_JOB_NAME,
      { importJobId },
      buildImportJobOptions(),
    );

    // The regression: a dedup would hand back `first.id` here. FIX 1
    // guarantees a distinct id every time (no jobId pinned at all).
    expect(second.id).toBeDefined();
    expect(second.id).not.toBe(first.id);

    // And it must be genuinely queued, not merely "resolved" — assert it
    // is actually retrievable and reaches completion on its own, proving
    // BullMQ picked it up as real work rather than short-circuiting.
    const fetchedSecond = await queue.getJob(second.id!);
    expect(fetchedSecond).toBeDefined();
    await waitForCompleted(second.id!);
  }, 30_000);
});
