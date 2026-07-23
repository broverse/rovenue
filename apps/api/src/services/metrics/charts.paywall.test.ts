import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isClickHouseConfiguredMock = vi.fn();
const queryAnalyticsMock = vi.fn();

vi.mock("../../lib/clickhouse", () => ({
  isClickHouseConfigured: (...args: unknown[]) =>
    isClickHouseConfiguredMock(...args),
  queryAnalytics: (...args: unknown[]) => queryAnalyticsMock(...args),
  ClickHouseUnavailableError: class ClickHouseUnavailableError extends Error {},
}));

import { readChartSeries } from "./charts";

// readChartSeries builds its window off the real clock (buildWindow ->
// `new Date()`), but the fixture rows below are pinned to 2026-07-02.
// Freeze the clock so a windowDays=7 lookback deterministically covers
// that date regardless of what day this suite actually runs on —
// otherwise these are wall-clock-coupled and only pass by coincidence.
const FROZEN_NOW = new Date("2026-07-02T12:00:00.000Z");

describe("readChartSeries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    queryAnalyticsMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports supported:false and no points for an id with no reader", async () => {
    const res = await readChartSeries("proj_1", "churn", 7);
    expect(res.supported).toBe(false);
    expect(res.points).toEqual([]);
    expect(res.chartId).toBe("churn");
    // An unwired chart must never trigger a query — that is how the
    // old page ended up showing MRR data under another chart's name.
    expect(queryAnalyticsMock).not.toHaveBeenCalled();
  });

  it("paywall_view_rate divides unique viewers by daily active subscribers", async () => {
    queryAnalyticsMock
      .mockResolvedValueOnce([{ day: "2026-07-02", n: "30" }]) // viewers
      .mockResolvedValueOnce([{ day: "2026-07-02", n: "120" }]); // actives

    const res = await readChartSeries("proj_1", "paywall_view_rate", 7);

    expect(res.supported).toBe(true);
    expect(res.unit).toBe("percent");
    const day = res.points.find((p) => p.bucket.startsWith("2026-07-02"));
    expect(day?.value).toBe(25);

    const [viewersCall, activesCall] = queryAnalyticsMock.mock.calls as [
      [string, string, Record<string, unknown>],
      [string, string, Record<string, unknown>],
    ];
    expect(viewersCall[1]).toContain("mv_paywall_daily_target");
    expect(viewersCall[1]).toContain("uniqMerge(subscribersHll)");
    // sdk_sessions_daily_tbl (0010) was dropped by migration 0016
    // (query-time idempotent view replaced the double-counting
    // SummingMergeTree rollup) — v_sdk_sessions_daily is what actually
    // exists in ClickHouse today; verified by hand in Step 6.
    expect(activesCall[1]).toContain("v_sdk_sessions_daily");
    expect(viewersCall[2]).toMatchObject({ projectId: "proj_1" });
  });

  it("paywall_purchase divides paywall-attributed purchasers by viewers, filtering empty paywallId", async () => {
    queryAnalyticsMock
      .mockResolvedValueOnce([{ day: "2026-07-02", n: "6" }]) // purchasers
      .mockResolvedValueOnce([{ day: "2026-07-02", n: "30" }]); // viewers

    const res = await readChartSeries("proj_1", "paywall_purchase", 7);

    expect(res.supported).toBe(true);
    const day = res.points.find((p) => p.bucket.startsWith("2026-07-02"));
    expect(day?.value).toBe(20);

    const purchasersSql = (
      queryAnalyticsMock.mock.calls[0] as [string, string, unknown]
    )[1];
    expect(purchasersSql).toContain("raw_revenue_events");
    // Pre-0019 rows carry '' and must not be counted as attributed.
    expect(purchasersSql).toContain("paywallId != ''");
    // Numerator is INITIAL only — RENEWAL/REACTIVATION recur long
    // after the view that earned them, and TRIAL_CONVERSION has the
    // same lag (trial starts are already INITIAL events), so counting
    // any of them against *today's* viewers inflates this same-day
    // rate past 100%. See PURCHASE_NUMERATOR_EVENT_TYPE in charts.ts.
    expect(purchasersSql).toContain("type = 'INITIAL'");
    expect(purchasersSql).not.toContain("RENEWAL");
    expect(purchasersSql).not.toContain("TRIAL_CONVERSION");
    expect(purchasersSql).not.toContain("REACTIVATION");
  });

  it("paywall_purchase's numerator excludes RENEWAL rows even when they carry the original paywallId", async () => {
    // Guards Finding 1: a renewal keeps the subscription's original
    // presentedContext/paywallId (Stripe copies it forward at
    // creation and never clears it), so a purchaser query that
    // doesn't restrict `type` would count month-2+ renewals against
    // today's viewers and blow past 100%. This test only inspects
    // the emitted SQL (no live ClickHouse in this suite) — the
    // positive-branch proof against real data lives in the task
    // report's hand-run section.
    queryAnalyticsMock
      .mockResolvedValueOnce([{ day: "2026-07-02", n: "1" }]) // purchasers
      .mockResolvedValueOnce([{ day: "2026-07-02", n: "5" }]); // viewers

    await readChartSeries("proj_1", "paywall_purchase", 7);

    const purchasersSql = (
      queryAnalyticsMock.mock.calls[0] as [string, string, unknown]
    )[1];
    expect(purchasersSql).toMatch(/type\s*=\s*'INITIAL'/);
  });

  it("throws when ClickHouse is not configured", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    await expect(
      readChartSeries("proj_1", "paywall_view_rate", 7),
    ).rejects.toThrow();
  });
});
