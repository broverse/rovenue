import { describe, expect, test, vi } from "vitest";
import { deleteWebhookEventsOlderThan } from "./webhook-events";

// =============================================================
// Unit tests for the batched deleteWebhookEventsOlderThan.
//
// We test the looping / accumulation behaviour by injecting a
// fake `db` whose `execute` returns configurable rowCount values.
// The real SQL text is integration-tested via the existing
// webhook-events.integration.test.ts suite.
// =============================================================

function makeDb(rowCounts: number[]) {
  let call = 0;
  return {
    execute: vi.fn(async () => {
      const n = rowCounts[call++] ?? 0;
      return { rowCount: n };
    }),
  };
}

const CUTOFF = new Date("2026-01-01T00:00:00Z");

describe("deleteWebhookEventsOlderThan — batched loop", () => {
  test("returns 0 and makes 1 execute call when table is empty", async () => {
    const db = makeDb([0]);
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF);
    expect(total).toBe(0);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  test("returns count and stops after a partial batch (< batchSize)", async () => {
    // First batch returns 3 rows, batchSize = 10 → partial → stop
    const db = makeDb([3]);
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF, 10);
    expect(total).toBe(3);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  test("loops when first batch is full and stops on partial second batch", async () => {
    // batchSize = 2; first batch full (2), second partial (1)
    const db = makeDb([2, 1]);
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF, 2);
    expect(total).toBe(3);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  test("accumulates across many full batches then stops on empty batch", async () => {
    // batchSize = 2; three full batches then 0
    const db = makeDb([2, 2, 2, 0]);
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF, 2);
    expect(total).toBe(6);
    expect(db.execute).toHaveBeenCalledTimes(4);
  });

  test("respects maxBatches safety ceiling", async () => {
    // batchSize = 2, maxBatches = 3; all batches full → ceiling hit
    const db = makeDb([2, 2, 2, 2, 2]);
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF, 2, 3);
    // Should stop after 3 batches regardless of further rows
    expect(total).toBe(6);
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  test("execute receives a drizzle sql object (not a raw string)", async () => {
    // The implementation uses drizzle's sql`` template tag so that
    // parameters are safely bound — not concatenated as a raw string.
    const db = makeDb([0]);
    await deleteWebhookEventsOlderThan(db as any, CUTOFF, 10);
    const sqlArg = (db.execute.mock.calls[0] as unknown[])[0];
    // A drizzle sql object is never a primitive string.
    expect(typeof sqlArg).toBe("object");
    expect(sqlArg).not.toBeNull();
    // Traverse the sql object's own enumerable values to find the Date
    // binding that represents the cutoff.
    const allValues: unknown[] = [];
    function collect(obj: unknown, depth = 0) {
      if (depth > 6 || !obj || typeof obj !== "object") return;
      if (obj instanceof Date) { allValues.push(obj); return; }
      for (const v of Object.values(obj as Record<string, unknown>)) collect(v, depth + 1);
    }
    collect(sqlArg);
    expect(allValues).toContainEqual(CUTOFF);
  });

  test("does not use .returning() — execute result is read via rowCount not array length", async () => {
    // If returning() were used the result would be an array, not {rowCount}.
    // Returning rowCount:5 should yield total=5 (not 0 from .length of non-array).
    const db = makeDb([5]);
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF, 10);
    expect(total).toBe(5);
  });
});
