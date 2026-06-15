import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {} as unknown,
    webhookEventRepo: {
      deleteWebhookEventsOlderThan: vi.fn(async (_db: unknown, _cutoff: Date) => 0),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", () => ({
  drizzle: drizzleMock,
}));

// =============================================================
// System under test (imported after mocks)
// =============================================================

import { runWebhookRetention } from "../src/workers/webhook-retention";
// Import the repo function directly to unit-test the batching logic
// (the @rovenue/db mock above only affects the drizzle namespace export,
// not this direct import of the repository source file).
import { deleteWebhookEventsOlderThan } from "@rovenue/db/src/drizzle/repositories/webhook-events";

// =============================================================
// Helpers
// =============================================================

const NOW = new Date("2026-05-01T12:00:00Z");
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan.mockResolvedValue(0);
});

// =============================================================
// Tests
// =============================================================

// =============================================================
// Helper to build a fake db whose execute() returns sequential rowCounts
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
  test("returns 0 and calls execute once when table is empty", async () => {
    const db = makeDb([0]);
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF);
    expect(total).toBe(0);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  test("stops after a partial batch (fewer rows than batchSize)", async () => {
    const db = makeDb([3]); // 3 < batchSize=10 → partial → stop
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF, 10);
    expect(total).toBe(3);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  test("loops when first batch is full; stops on partial second batch", async () => {
    const db = makeDb([2, 1]); // batchSize=2; full then partial
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF, 2);
    expect(total).toBe(3);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  test("accumulates totals across multiple full batches then empty", async () => {
    const db = makeDb([2, 2, 2, 0]); // batchSize=2; 3 full + 1 empty
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF, 2);
    expect(total).toBe(6);
    expect(db.execute).toHaveBeenCalledTimes(4);
  });

  test("respects maxBatches safety ceiling", async () => {
    const db = makeDb([2, 2, 2, 2, 2]); // all full; maxBatches=3 → stop at 3
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF, 2, 3);
    expect(total).toBe(6);
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  test("does not use .returning() — total derived from rowCount not array length", async () => {
    // If .returning() were used the result would be an array and rowCount would be
    // absent, yielding 0 instead of 5.
    const db = makeDb([5]);
    const total = await deleteWebhookEventsOlderThan(db as any, CUTOFF, 10);
    expect(total).toBe(5);
  });

  test("rows newer than cutoff survive — execute receives a drizzle sql object", async () => {
    const db = makeDb([0]);
    await deleteWebhookEventsOlderThan(db as any, CUTOFF, 10);
    const sqlArg = db.execute.mock.calls[0]![0];
    // drizzle sql`` produces an object, never a raw string
    expect(typeof sqlArg).toBe("object");
    expect(sqlArg).not.toBeNull();
    // Verify the cutoff Date is bound (not interpolated as a string)
    const allValues: unknown[] = [];
    function collect(obj: unknown, depth = 0) {
      if (depth > 6 || !obj || typeof obj !== "object") return;
      if (obj instanceof Date) { allValues.push(obj); return; }
      for (const v of Object.values(obj as Record<string, unknown>)) collect(v, depth + 1);
    }
    collect(sqlArg);
    expect(allValues).toContainEqual(CUTOFF);
  });
});

describe("runWebhookRetention", () => {
  test("calls deleteWebhookEventsOlderThan with a cutoff 90 days before `now`", async () => {
    await runWebhookRetention(NOW);

    expect(
      drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan,
    ).toHaveBeenCalledOnce();
    const call =
      drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan.mock.calls[0]!;
    const cutoff = call[1] as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBe(NOW.getTime() - NINETY_DAYS_MS);
  });

  test("returns { deleted, cutoff } with the repo's count and ISO8601 cutoff", async () => {
    drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan.mockResolvedValue(
      42,
    );

    const result = await runWebhookRetention(NOW);

    expect(result.deleted).toBe(42);
    expect(result.cutoff).toBe(
      new Date(NOW.getTime() - NINETY_DAYS_MS).toISOString(),
    );
    // Sanity: ISO8601 round-trips.
    expect(new Date(result.cutoff).toISOString()).toBe(result.cutoff);
  });

  test("propagates the repo error unchanged", async () => {
    drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan.mockRejectedValue(
      new Error("db down"),
    );

    await expect(runWebhookRetention(NOW)).rejects.toThrow("db down");
  });

  test("defaults `now` to the current time when no argument is provided", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);

      await runWebhookRetention();

      const call =
        drizzleMock.webhookEventRepo.deleteWebhookEventsOlderThan.mock.calls[0]!;
      const cutoff = call[1] as Date;
      expect(cutoff.getTime()).toBe(NOW.getTime() - NINETY_DAYS_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});
