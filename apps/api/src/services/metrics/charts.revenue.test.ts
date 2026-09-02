import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dispatch tests for the four revenue chart-series ids (mrr, arr,
// gross_vs_net, arpu). All four delegate to `listDailyMrr` — mocking
// `queryAnalytics` (the seam `listDailyMrr` itself calls through)
// exercises the real delegation and reshaping, with no ClickHouse
// needed. Mirrors charts.paywall.test.ts's mocking setup.

const isClickHouseConfiguredMock = vi.fn();
const queryAnalyticsMock = vi.fn();

vi.mock("../../lib/clickhouse", () => ({
  isClickHouseConfigured: (...args: unknown[]) =>
    isClickHouseConfiguredMock(...args),
  queryAnalytics: (...args: unknown[]) => queryAnalyticsMock(...args),
  ClickHouseUnavailableError: class ClickHouseUnavailableError extends Error {},
}));

import { readChartSeries } from "./charts";

const FROZEN_NOW = new Date("2026-07-02T12:00:00.000Z");

/** Shape `listDailyMrr` expects back from `queryAnalytics` (ChMrrRow). */
function chRow(overrides: Partial<Record<string, string>> = {}) {
  return {
    bucket: "2026-07-02 00:00:00",
    gross_usd: "150",
    refunds_usd: "30",
    net_usd: "120",
    event_count: "5",
    active_subscribers: "4",
    ...overrides,
  };
}

describe("readChartSeries — revenue ids", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    queryAnalyticsMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mrr: unit is money, value is netUsd for the day", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([chRow()]);
    const res = await readChartSeries("proj_1", "mrr", 7);
    expect(res.supported).toBe(true);
    expect(res.unit).toBe("money");
    const day = res.points.find((p) => p.bucket.startsWith("2026-07-02"));
    expect(day?.value).toBe(120);
  });

  it("arr: unit is money, value is netUsd x12", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([chRow()]);
    const res = await readChartSeries("proj_1", "arr", 7);
    expect(res.supported).toBe(true);
    expect(res.unit).toBe("money");
    const day = res.points.find((p) => p.bucket.startsWith("2026-07-02"));
    expect(day?.value).toBe(1440);
  });

  it("gross_vs_net: unit is percent, value is net ÷ gross as a 0-100 number", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([chRow()]);
    const res = await readChartSeries("proj_1", "gross_vs_net", 7);
    expect(res.supported).toBe(true);
    expect(res.unit).toBe("percent");
    const day = res.points.find((p) => p.bucket.startsWith("2026-07-02"));
    // net_usd 120 / gross_usd 150 = 80%.
    expect(day?.value).toBe(80);
  });

  it("gross_vs_net: null, not zero, on a day with zero gross revenue", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([
      chRow({ gross_usd: "0", refunds_usd: "0", net_usd: "0" }),
    ]);
    const res = await readChartSeries("proj_1", "gross_vs_net", 7);
    const day = res.points.find((p) => p.bucket.startsWith("2026-07-02"));
    expect(day?.value).toBeNull();
  });

  it("arpu: unit is money, value is netUsd / activeSubscribers", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([chRow()]);
    const res = await readChartSeries("proj_1", "arpu", 7);
    expect(res.supported).toBe(true);
    expect(res.unit).toBe("money");
    const day = res.points.find((p) => p.bucket.startsWith("2026-07-02"));
    expect(day?.value).toBe(30);
  });

  it("arpu: null, not zero, on a day with zero active subscribers", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([
      chRow({ active_subscribers: "0", net_usd: "0" }),
    ]);
    const res = await readChartSeries("proj_1", "arpu", 7);
    const day = res.points.find((p) => p.bucket.startsWith("2026-07-02"));
    expect(day?.value).toBeNull();
  });

  it("issues zero ClickHouse round-trips for an id that isn't mrr/arr/gross_vs_net/arpu", async () => {
    const res = await readChartSeries("proj_1", "ltv", 7);
    expect(res.supported).toBe(false);
    expect(res.unit).toBe("count");
    expect(queryAnalyticsMock).not.toHaveBeenCalled();
  });

  it("throws when ClickHouse is not configured", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    await expect(readChartSeries("proj_1", "mrr", 7)).rejects.toThrow();
  });
});
