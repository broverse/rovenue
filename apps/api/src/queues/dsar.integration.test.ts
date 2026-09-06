// =============================================================
// dsar queues — real-Redis queue-split regression test (Finding 1,
// roadmap-9a DSAR combined fix round)
// =============================================================
//
// routes/v1/dsar.test.ts mocks THIS module (`../../queues/dsar`) wholesale
// — every export, including `enqueueDsarJob`, is replaced by a
// `vi.fn().mockResolvedValue(undefined)` stub. That proves the ROUTE calls
// `enqueueDsarJob` with the right job name; it can never prove
// `enqueueDsarJob` actually routes an EXPORT job and an ERASURE job onto
// two DIFFERENT BullMQ queues, because a mock has no queues to route onto
// in the first place. This file imports the REAL, unmocked module and
// exercises it against live Redis (ambient docker-compose, host port
// 6380) — the same infra every other `*.integration.test.ts` in this repo
// uses.
//
// Mutation this test catches: collapsing DSAR_EXPORT_QUEUE_NAME and
// DSAR_ERASURE_QUEUE_NAME back into one shared queue name (Task 3's
// original shape, which the controller overruled for Task 4 — see
// queues/dsar.ts's module doc), or having `queueForJobName` route both
// job names onto the same `Queue` instance regardless of name. Verified
// by actually making that change, watching this test fail, and reverting
// — see task-4-report.md for the red-check transcript.
//
// Cleanup: every job this test adds uses a throwaway `dsarRequestId`
// scoped to this run and is explicitly removed in `afterAll` — this test
// enqueues onto the SAME queues the real dsar-export/dsar-erasure workers
// consume from (there is no test-only queue name to isolate into, since
// the routing under test IS `DSAR_EXPORT_QUEUE_NAME`/
// `DSAR_ERASURE_QUEUE_NAME` themselves), so nothing may be left behind
// for a real worker to pick up.

process.env.REDIS_URL ??= "redis://localhost:6380";

import { afterAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import {
  enqueueDsarJob,
  getDsarExportQueue,
  getDsarErasureQueue,
  DSAR_EXPORT_JOB_NAME,
  DSAR_ERASURE_JOB_NAME,
  DSAR_EXPORT_QUEUE_NAME,
  DSAR_ERASURE_QUEUE_NAME,
  type DsarJobData,
} from "./dsar";

const RUN_ID = createId();
const projectId = `prj_dsarqtest_${RUN_ID}`;

const enqueuedJobIds: string[] = [];

function makeJobData(type: DsarJobData["type"]): DsarJobData {
  const dsarRequestId = `dsarqtest_${type.toLowerCase()}_${createId()}`;
  enqueuedJobIds.push(dsarRequestId);
  return {
    dsarRequestId,
    projectId,
    subscriberId: `sub_dsarqtest_${createId()}`,
    type,
  };
}

afterAll(async () => {
  const exportQueue = getDsarExportQueue();
  const erasureQueue = getDsarErasureQueue();
  for (const id of enqueuedJobIds) {
    await exportQueue.remove(id).catch(() => {});
    await erasureQueue.remove(id).catch(() => {});
  }
  await exportQueue.close();
  await erasureQueue.close();
});

describe("dsar queue split (real Redis, unmocked queues/dsar)", () => {
  it("puts an EXPORT job and an ERASURE job on two different queues", async () => {
    // The names themselves must differ before anything else is worth
    // asserting.
    expect(DSAR_EXPORT_QUEUE_NAME).not.toBe(DSAR_ERASURE_QUEUE_NAME);

    const exportData = makeJobData("EXPORT");
    const erasureData = makeJobData("ERASURE");

    // The one production entry point — never `.add()` directly.
    await enqueueDsarJob(DSAR_EXPORT_JOB_NAME, exportData);
    await enqueueDsarJob(DSAR_ERASURE_JOB_NAME, erasureData);

    const exportQueue = getDsarExportQueue();
    const erasureQueue = getDsarErasureQueue();

    // The EXPORT job landed on the export queue...
    const exportJobOnExportQueue = await exportQueue.getJob(exportData.dsarRequestId);
    expect(exportJobOnExportQueue).toBeDefined();
    expect(exportJobOnExportQueue?.data).toEqual(exportData);

    // ...and is genuinely ABSENT from the erasure queue — a real, separate
    // BullMQ queue backed by its own Redis keys, not merely a filtered
    // view of one shared queue.
    const exportJobOnErasureQueue = await erasureQueue.getJob(exportData.dsarRequestId);
    expect(exportJobOnErasureQueue).toBeUndefined();

    // Mirror-image for the ERASURE job: present on its own queue, absent
    // from the other.
    const erasureJobOnErasureQueue = await erasureQueue.getJob(erasureData.dsarRequestId);
    expect(erasureJobOnErasureQueue).toBeDefined();
    expect(erasureJobOnErasureQueue?.data).toEqual(erasureData);

    const erasureJobOnExportQueue = await exportQueue.getJob(erasureData.dsarRequestId);
    expect(erasureJobOnExportQueue).toBeUndefined();
  });

  it("re-enqueuing an existing jobId is a safe no-op, not a silent job loss (Finding 3)", async () => {
    // roadmap-9a final fix wave, Finding 3: routes/v1/dsar.ts now
    // re-attempts `enqueueDsarJob` for a row it already knows is open
    // (healing a first attempt whose enqueue may have failed to reach
    // Redis at all). That design is only safe because BullMQ's own
    // jobId-based dedup means calling `.add()` again for an id that
    // ALREADY has a live job returns that SAME job rather than either
    // creating a duplicate or discarding it — the exact failure this
    // repo has shipped before with a pinned jobId ("every re-enqueue a
    // silent no-op", see queues/dsar.ts's own comment). This is that
    // property, proven against REAL Redis: add once, add again with
    // identical data, and the queue must still hold exactly the ORIGINAL
    // job — same BullMQ job id, same data, present and gettable — not
    // zero jobs and not two.
    const data = makeJobData("EXPORT");

    await enqueueDsarJob(DSAR_EXPORT_JOB_NAME, data);
    const exportQueue = getDsarExportQueue();
    const before = await exportQueue.getJob(data.dsarRequestId);
    expect(before).toBeDefined();
    expect(before?.data).toEqual(data);

    // The second enqueue — this is the exact call
    // `createOrReturnOpenDsarRequest`'s heal path makes on every retry of
    // an already-open row, whether or not the first attempt actually
    // needed healing.
    await enqueueDsarJob(DSAR_EXPORT_JOB_NAME, data);

    const after = await exportQueue.getJob(data.dsarRequestId);
    expect(after).toBeDefined();
    expect(after?.id).toBe(before?.id);
    expect(after?.data).toEqual(data);

    // Exactly one job with this id sits in the queue's waiting set — the
    // duplicate `.add()` did not fork a second entry alongside it.
    const waitingJobs = await exportQueue.getWaiting();
    expect(waitingJobs.filter((j) => j.id === data.dsarRequestId)).toHaveLength(1);
  });

  it("a job that was never actually created is genuinely created by the healing enqueue (Finding 3)", async () => {
    // The other half of the same safety argument: the healing call must
    // not ALSO be a no-op when there is truly nothing to dedupe against
    // yet (the row committed, but the original `enqueueDsarJob` never
    // reached Redis at all — a real Redis blip, not simulated by mocking
    // BullMQ itself). This is simply confirming the ordinary case still
    // works: no job exists for this id before the call, one exists,
    // waiting and gettable, immediately after it.
    const data = makeJobData("ERASURE");
    const erasureQueue = getDsarErasureQueue();

    expect(await erasureQueue.getJob(data.dsarRequestId)).toBeUndefined();

    await enqueueDsarJob(DSAR_ERASURE_JOB_NAME, data);

    const job = await erasureQueue.getJob(data.dsarRequestId);
    expect(job).toBeDefined();
    expect(job?.data).toEqual(data);
    const state = await job?.getState();
    expect(state).toBe("waiting");
  });
});
