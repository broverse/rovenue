import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// outbox dispatcher — per-topic isolation test (E.1)
// =============================================================
//
// Validates that when rovenue.revenue publish fails, rovenue.exposures
// keeps draining and the per-topic backoff state increments correctly.
//
// Uses vi.mock instead of real containers: the dispatcher logic (grouping,
// allSettled, backoff state, markPublished calls) is purely in-process.
// DB interactions are stubbed; no Postgres or Redpanda needed.

// ---------------------------------------------------------------------------
// Hoisted mock values (must be set up before module imports)
// ---------------------------------------------------------------------------

// Fake outbox rows inserted "directly" into the DB.
const fakeExposureRows = Array.from({ length: 5 }, (_, i) => ({
  id: `evt_exp_${i}`,
  aggregateType: "EXPOSURE" as const,
  aggregateId: `agg_exp_${i}`,
  eventType: "experiment.exposure.recorded",
  payload: { experimentId: `exp_${i}`, variantId: "var_a" },
  createdAt: new Date(),
  publishedAt: null,
}));

const fakeRevenueRows = Array.from({ length: 5 }, (_, i) => ({
  id: `evt_rev_${i}`,
  aggregateType: "REVENUE_EVENT" as const,
  aggregateId: `agg_rev_${i}`,
  eventType: "revenue.event.recorded",
  payload: { amount: 9.99, currency: "USD" },
  createdAt: new Date(),
  publishedAt: null,
}));

// All 10 rows returned on first claimBatch call; subsequent calls return empty.
const allRows = [...fakeExposureRows, ...fakeRevenueRows];

// Track which IDs get marked published so we can assert REVENUE rows stay NULL.
const markedPublishedIds: string[] = [];

// claimBatch mock: returns all rows the first call, empty thereafter.
let claimBatchCallCount = 0;

const mockClaimBatch = vi.hoisted(() =>
  vi.fn(async (_tx: unknown, _limit: number) => {
    claimBatchCallCount += 1;
    if (claimBatchCallCount === 1) return allRows;
    return [];
  }),
);

const mockMarkPublished = vi.hoisted(() =>
  vi.fn(async (_tx: unknown, ids: string[]) => {
    markedPublishedIds.push(...ids);
  }),
);

// Transaction mock — just invokes the callback with a dummy tx object.
const mockTransaction = vi.hoisted(() =>
  vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
);

vi.mock("@rovenue/db", () => ({
  drizzle: {
    outboxRepo: {
      claimBatch: mockClaimBatch,
      markPublished: mockMarkPublished,
    },
  },
  getDb: vi.fn(() => ({
    transaction: mockTransaction,
  })),
}));

// ---------------------------------------------------------------------------
// Kafka producer mock — exposures OK, revenue always rejects
// ---------------------------------------------------------------------------

const mockSend = vi.hoisted(() =>
  vi.fn(async ({ topic }: { topic: string }) => {
    if (topic === "rovenue.revenue") {
      throw new Error("simulated Kafka publish failure for rovenue.revenue");
    }
    // rovenue.exposures and rovenue.credit succeed.
    return [{ topicName: topic, partition: 0, errorCode: 0 }];
  }),
);

vi.mock("../src/lib/kafka", () => ({
  getProducer: vi.fn(async () => ({ send: mockSend })),
  assertTopic: vi.fn(async () => undefined),
  disconnectKafka: vi.fn(async () => undefined),
  getResolvedBrokers: vi.fn(() => "localhost:19093"),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks are registered
// ---------------------------------------------------------------------------

import { Logger } from "../src/lib/logger";
import {
  runOnce,
  topicBackoff,
  getBackoffState,
} from "../src/workers/outbox-dispatcher";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("outbox dispatcher — per-topic isolation", () => {
  // Capture logger.warn calls.
  const warnCalls: Array<[string, unknown]> = [];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset shared state between test runs.
    claimBatchCallCount = 0;
    markedPublishedIds.length = 0;
    topicBackoff.clear();
    mockClaimBatch.mockClear();
    mockMarkPublished.mockClear();
    mockTransaction.mockClear();
    mockSend.mockClear();
    warnCalls.length = 0;

    warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(
      function (msg, fields) {
        warnCalls.push([msg, fields as unknown]);
      },
    );
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it(
    "healthy topic drains while sick topic backs off",
    async () => {
      // Pull the mocked producer (send mock).
      const { getProducer } = await import("../src/lib/kafka");
      const producer = (await getProducer()) as NonNullable<
        Awaited<ReturnType<typeof getProducer>>
      >;

      // Cycle 1: claimBatch returns all 10 rows.
      // rovenue.exposures succeeds; rovenue.revenue fails.
      await runOnce(producer);

      // Cycle 2 & 3: claimBatch returns [] (rows are either published or
      // still in backoff). The revenue rows stay NULL because markPublished
      // is never called for them. We run 2 more cycles to drive backoff to
      // consecutiveFailures >= 3 (each cycle where the topic is backing off
      // doesn't re-attempt; to hit failure count 3 we need the topic to
      // fail on 3 separate claimBatch cycles that actually claim revenue rows).
      //
      // Strategy: reset claimBatch so it returns revenue rows again on cycles
      // 2 and 3, simulating the dispatcher re-claiming unpublished rows.
      claimBatchCallCount = 0; // allow re-claim for cycle 2
      mockClaimBatch.mockImplementation(async (_tx: unknown, _limit: number) => {
        claimBatchCallCount += 1;
        // On cycles 2+, return only revenue rows (exposure rows are published).
        // But on cycle 2, the topic may still be in backoff (nextAttemptAt in
        // the future) — so the dispatcher will skip these rows. To force
        // re-attempt on cycle 2, reset nextAttemptAt so the topic is not
        // considered backing off (simulating time advancing past the backoff).
        return fakeRevenueRows;
      });

      // Reset nextAttemptAt so cycle 2 is not blocked by backoff from cycle 1.
      const state1 = topicBackoff.get("rovenue.revenue");
      if (state1) {
        topicBackoff.set("rovenue.revenue", {
          ...state1,
          nextAttemptAt: 0, // expired
        });
      }

      // Cycle 2: revenue rows re-claimed, revenue topic still fails.
      await runOnce(producer);

      // Reset backoff timer again for cycle 3.
      const state2 = topicBackoff.get("rovenue.revenue");
      if (state2) {
        topicBackoff.set("rovenue.revenue", {
          ...state2,
          nextAttemptAt: 0,
        });
      }

      // Cycle 3: revenue rows re-claimed, revenue topic fails again.
      await runOnce(producer);

      // ---------------------------------------------------------------------------
      // Assertions
      // ---------------------------------------------------------------------------

      // 5 EXPOSURE rows should have been marked published.
      const exposureIds = new Set(fakeExposureRows.map((r) => r.id));
      const markedExposures = markedPublishedIds.filter((id) =>
        exposureIds.has(id),
      );
      expect(markedExposures).toHaveLength(5);

      // 5 REVENUE_EVENT rows should NOT have been marked published (publishedAt stays NULL).
      const revenueIds = new Set(fakeRevenueRows.map((r) => r.id));
      const markedRevenue = markedPublishedIds.filter((id) =>
        revenueIds.has(id),
      );
      expect(markedRevenue).toHaveLength(0);

      // Backoff state for rovenue.revenue should have consecutiveFailures >= 3.
      const backoffState = getBackoffState("rovenue.revenue");
      expect(backoffState).toBeDefined();
      expect(backoffState!.consecutiveFailures).toBeGreaterThanOrEqual(3);

      // At least one logger.warn call with the topic-backoff message.
      // BACKOFF_LOG_THRESHOLD is 3 — warn fires when consecutiveFailures >= 3.
      const topicBackoffWarns = warnCalls.filter(
        ([msg]) => msg === "outbox.dispatcher.topic-backoff",
      );
      expect(topicBackoffWarns.length).toBeGreaterThanOrEqual(1);

      // Verify the warn was for the right topic.
      const [, firstWarnFields] = topicBackoffWarns[0]!;
      expect(firstWarnFields).toMatchObject({
        topic: "rovenue.revenue",
      });

      // rovenue.exposures backoff state should be cleared (succeeded).
      expect(topicBackoff.has("rovenue.exposures")).toBe(false);
    },
    15_000,
  );
});
