import { describe, expect, it } from "vitest";
import {
  IMPORT_QUEUE_NAME,
  IMPORT_BATCH_SIZE,
  IMPORT_JOB_CONCURRENCY_PER_PROJECT,
  buildImportJobOptions,
} from "./imports";

describe("import queue constants", () => {
  it("queue name is rovenue-imports", () => {
    expect(IMPORT_QUEUE_NAME).toBe("rovenue-imports");
  });

  it("batch size is a positive, named constant", () => {
    expect(IMPORT_BATCH_SIZE).toBeGreaterThan(0);
  });

  it("per-project concurrency is 1 — the lock in import-runner.ts is a plain mutex", () => {
    expect(IMPORT_JOB_CONCURRENCY_PER_PROJECT).toBe(1);
  });
});

describe("buildImportJobOptions", () => {
  it("uses the import job's own id as the BullMQ jobId", () => {
    expect(buildImportJobOptions("job1").jobId).toBe("job1");
  });

  it("does NOT pin a custom backoff — this queue never installs a backoffStrategy", () => {
    // Regression guard for the OPPOSITE mistake queues/integrations.ts
    // documents: declaring `backoff: { type: "custom" }` on the job
    // without a worker-side `settings.backoffStrategy` is just as inert
    // as the reverse (a custom strategy with no `type: "custom"` on the
    // job) — BullMQ would silently fall back to its default backoff
    // either way. This queue deliberately uses the built-in exponential
    // strategy end to end, so it must never claim "custom".
    const opts = buildImportJobOptions("job1");
    expect(opts.backoff).toEqual({ type: "exponential", delay: 30_000 });
  });

  it("sets a bounded retry budget and removal policy", () => {
    const opts = buildImportJobOptions("job1");
    expect(opts.attempts).toBe(5);
    expect(opts.removeOnComplete).toEqual({ age: 7 * 86_400, count: 1_000 });
    expect(opts.removeOnFail).toEqual({ age: 30 * 86_400 });
  });
});
