import { describe, expect, it } from "vitest";
import {
  IMPORT_QUEUE_NAME,
  IMPORT_BATCH_SIZE,
  IMPORT_JOB_CONCURRENCY_PER_PROJECT,
  buildImportJobOptions,
  buildImportDryRunJobOptions,
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
  // Final-fix-wave FIX 1 regression guard: a pinned `jobId` made every
  // re-enqueue of a completed/failed job (still inside its
  // removeOnComplete/removeOnFail retention window) dedupe into a silent
  // no-op — BullMQ's `handleDuplicatedJob` returns the existing id
  // WITHOUT queueing anything, so `/resume`, a re-run dry run after a
  // mapping fix, and cancel-then-rerun all bricked. Each enqueue must now
  // get its own BullMQ-assigned id.
  it("does NOT pin a jobId — every enqueue must be a distinct BullMQ job", () => {
    expect(buildImportJobOptions().jobId).toBeUndefined();
  });

  it("does NOT pin a custom backoff — this queue never installs a backoffStrategy", () => {
    // Regression guard for the OPPOSITE mistake queues/integrations.ts
    // documents: declaring `backoff: { type: "custom" }` on the job
    // without a worker-side `settings.backoffStrategy` is just as inert
    // as the reverse (a custom strategy with no `type: "custom"` on the
    // job) — BullMQ would silently fall back to its default backoff
    // either way. This queue deliberately uses the built-in exponential
    // strategy end to end, so it must never claim "custom".
    const opts = buildImportJobOptions();
    expect(opts.backoff).toEqual({ type: "exponential", delay: 30_000 });
  });

  it("sets a bounded retry budget and removal policy", () => {
    const opts = buildImportJobOptions();
    expect(opts.attempts).toBe(5);
    expect(opts.removeOnComplete).toEqual({ age: 7 * 86_400, count: 1_000 });
    expect(opts.removeOnFail).toEqual({ age: 30 * 86_400 });
  });
});

describe("buildImportDryRunJobOptions", () => {
  it("does NOT pin a jobId either — same FIX 1 reasoning as the commit/resume path", () => {
    expect(buildImportDryRunJobOptions().jobId).toBeUndefined();
  });
});
