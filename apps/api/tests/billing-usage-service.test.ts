import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  class ClickHouseUnavailableError extends Error {
    constructor(msg?: string) {
      super(msg ?? "ClickHouse is not configured; analytics query skipped");
      this.name = "ClickHouseUnavailableError";
    }
  }
  return {
    findSub: vi.fn(),
    findLimits: vi.fn(),
    countWebhooks: vi.fn(),
    countSql: vi.fn(),
    upsert: vi.fn(),
    markHard: vi.fn(),
    markSoft: vi.fn(),
    queryAnalytics: vi.fn(),
    ClickHouseUnavailableError,
  };
});

vi.mock("@rovenue/db", () => ({
  drizzle: {
    billingSubscriptionRepo: { findBillingSubscriptionByProject: mocks.findSub },
    billingTierLimitsRepo: { findByTierAndCycle: mocks.findLimits },
    webhookEventRepo: { countWebhookEventsInPeriod: mocks.countWebhooks },
    warehouseQueryRunRepo: { countQueryRunsInPeriod: mocks.countSql },
    usageSnapshotRepo: {
      upsertUsageSnapshot: mocks.upsert,
      markHardCapWarned: mocks.markHard,
      markSoftCapWarned: mocks.markSoft,
    },
  },
}));

vi.mock("../src/lib/clickhouse", () => ({
  queryAnalytics: mocks.queryAnalytics,
  ClickHouseUnavailableError: mocks.ClickHouseUnavailableError,
}));

import { buildUsageReport } from "../src/services/billing/usage";

const db = {} as any;

beforeEach(() => {
  mocks.findSub.mockReset();
  mocks.findLimits.mockReset();
  mocks.countWebhooks.mockReset();
  mocks.countSql.mockReset();
  mocks.upsert.mockReset();
  mocks.markHard.mockReset();
  mocks.markSoft.mockReset();
  mocks.queryAnalytics.mockReset();

  mocks.findSub.mockResolvedValue({
    tier: "pro",
    cycle: "monthly",
    currentPeriodStart: new Date("2026-05-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-06-01T00:00:00Z"),
  });
  mocks.findLimits.mockResolvedValue({ mtrMax: "50000", eventsLimit: 50000000, sqlLimit: 100 });
  mocks.countWebhooks.mockResolvedValue(200);
  mocks.countSql.mockResolvedValue(5);
  mocks.upsert.mockResolvedValue(undefined);
  mocks.markHard.mockResolvedValue(undefined);
  mocks.markSoft.mockResolvedValue(undefined);
});

describe("buildUsageReport", () => {
  it("maps the three meters with real limits and cap types", async () => {
    mocks.queryAnalytics
      .mockResolvedValueOnce([{ v: 4210.5 }])  // mtr
      .mockResolvedValueOnce([{ v: 800 }]);     // sdk events
    const r = await buildUsageReport(db, "proj_1");
    expect(r.tier).toBe("pro");
    const byKey = Object.fromEntries(r.meters.map((m) => [m.key, m]));
    expect(byKey.mtr).toMatchObject({ current: 4210.5, limit: 50000, cap: "soft", unit: "usd", available: true });
    expect(byKey.events).toMatchObject({ current: 1000, limit: 50000000, cap: "hard", available: true }); // 200 + 800
    expect(byKey.sql_queries).toMatchObject({ current: 5, limit: 100, cap: "hard", available: true });
  });

  it("degrades when ClickHouse is unavailable (request still succeeds)", async () => {
    mocks.queryAnalytics.mockRejectedValue(new mocks.ClickHouseUnavailableError("down"));
    const r = await buildUsageReport(db, "proj_1");
    const byKey = Object.fromEntries(r.meters.map((m) => [m.key, m]));
    expect(byKey.mtr).toMatchObject({ current: null, available: false });
    expect(byKey.events).toMatchObject({ current: 200, available: false }); // PG webhooks only
    expect(byKey.sql_queries).toMatchObject({ current: 5, available: true });
  });

  it("falls back to free tier + calendar month when no subscription", async () => {
    mocks.findSub.mockResolvedValue(null);
    mocks.findLimits.mockResolvedValue({ mtrMax: "3000", eventsLimit: 5000000, sqlLimit: 10 });
    mocks.queryAnalytics.mockResolvedValue([{ v: 0 }]);
    const r = await buildUsageReport(db, "proj_1");
    expect(r.tier).toBe("free");
    expect(mocks.findLimits).toHaveBeenCalledWith(db, "free", "monthly");
  });

  it("marks hard cap when events meet the limit", async () => {
    mocks.findLimits.mockResolvedValue({ mtrMax: "50000", eventsLimit: 100, sqlLimit: 100 });
    mocks.countWebhooks.mockResolvedValue(100);
    mocks.queryAnalytics
      .mockResolvedValueOnce([{ v: 0 }])  // mtr
      .mockResolvedValueOnce([{ v: 0 }]); // sdk events
    await buildUsageReport(db, "proj_1");
    expect(mocks.markHard).toHaveBeenCalledWith(db, "proj_1", "events", expect.any(Date));
  });
});
