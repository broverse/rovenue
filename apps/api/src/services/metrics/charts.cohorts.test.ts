import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dispatch test for the two PERIOD-axis ids: retention_curve and ltv.
// Mocks cohorts.ts (the owning service) so this file tests charts.ts's
// own reshaping — the axis it declares, the null-vs-zero ruling for an
// empty cohort, and the per-member division — not the ClickHouse SQL,
// which schema-contract.integration.test.ts runs against a real schema.

const computeRetentionMock = vi.fn();
const computeCohortLtvCurveMock = vi.fn();
vi.mock("../cohorts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cohorts")>();
  return {
    ...actual,
    computeRetention: (...args: unknown[]) => computeRetentionMock(...args),
    computeCohortLtvCurve: (...args: unknown[]) =>
      computeCohortLtvCurveMock(...args),
  };
});

const isClickHouseConfiguredMock = vi.fn();
vi.mock("../../lib/clickhouse", () => ({
  isClickHouseConfigured: (...args: unknown[]) =>
    isClickHouseConfiguredMock(...args),
  queryAnalytics: vi.fn(),
  ClickHouseUnavailableError: class ClickHouseUnavailableError extends Error {},
}));

import { readChartSeries } from "./charts";

const FROZEN_NOW = new Date("2026-07-02T12:00:00.000Z");
// Window lengths that select each granularity band — see
// catalogCohortShape's thresholds in services/cohorts.ts.
const DAY_GRAIN_WINDOW = 30;
const WEEK_GRAIN_WINDOW = 180;
const MONTH_GRAIN_WINDOW = 365;
const COHORT_SIZE = 200;

describe("readChartSeries — cohort curves", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    computeRetentionMock.mockReset();
    computeCohortLtvCurveMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves retention_curve on a period axis, never a date one", async () => {
    computeRetentionMock.mockResolvedValueOnce({
      size: COHORT_SIZE,
      granularity: "week",
      periods: 2,
      points: [
        { period: 0, active: COHORT_SIZE, pct: 100 },
        { period: 1, active: 82, pct: 41 },
      ],
    });

    const res = await readChartSeries(
      "proj_1",
      "retention_curve",
      WEEK_GRAIN_WINDOW,
    );

    expect(res.supported).toBe(true);
    expect(res.axis).toBe("period");
    expect(res.unit).toBe("percent");
    if (res.axis !== "period") throw new Error("expected a period axis");
    expect(res.periodGranularity).toBe("week");
    expect(res.points[1]).toEqual({
      period: 1,
      value: 41,
      numerator: 82,
      denominator: COHORT_SIZE,
    });
    expect(res.points[0]).not.toHaveProperty("bucket");
  });

  it("reports null, not zero, for an empty cohort", async () => {
    // Nobody joined, so retention is UNDEFINED — plotting 0% would read
    // as total churn of a population that never existed.
    computeRetentionMock.mockResolvedValueOnce({
      size: 0,
      granularity: "week",
      periods: 2,
      points: [
        { period: 0, active: 0, pct: 0 },
        { period: 1, active: 0, pct: 0 },
      ],
    });

    const res = await readChartSeries(
      "proj_1",
      "retention_curve",
      WEEK_GRAIN_WINDOW,
    );

    expect(res.points.every((p) => p.value === null)).toBe(true);
  });

  it("serves ltv as cumulative net revenue per cohort member", async () => {
    computeCohortLtvCurveMock.mockResolvedValueOnce({
      size: 50,
      points: [
        { period: 0, cumulativeNetUsd: 500 },
        { period: 1, cumulativeNetUsd: 750 },
      ],
    });

    const res = await readChartSeries("proj_1", "ltv", WEEK_GRAIN_WINDOW);

    expect(res.axis).toBe("period");
    expect(res.unit).toBe("money");
    expect(res.points[1]).toEqual({
      period: 1,
      value: 15,
      numerator: 750,
      denominator: 50,
    });
  });

  it("picks the period granularity from the window length", async () => {
    const empty = {
      size: 0,
      granularity: "day" as const,
      periods: 1,
      points: [{ period: 0, active: 0, pct: 0 }],
    };
    computeRetentionMock.mockResolvedValue(empty);

    for (const [windowDays, expected] of [
      [DAY_GRAIN_WINDOW, "day"],
      [WEEK_GRAIN_WINDOW, "week"],
      [MONTH_GRAIN_WINDOW, "month"],
    ] as const) {
      const res = await readChartSeries(
        "proj_1",
        "retention_curve",
        windowDays,
      );
      if (res.axis !== "period") throw new Error("expected a period axis");
      expect(res.periodGranularity).toBe(expected);
    }
  });

  it("asks both curves for the SAME cohort", async () => {
    // The two panels are meant to describe one population; if their
    // rules ever diverge, reading them side by side becomes misleading.
    computeRetentionMock.mockResolvedValueOnce({
      size: 1,
      granularity: "week",
      periods: 1,
      points: [{ period: 0, active: 1, pct: 100 }],
    });
    computeCohortLtvCurveMock.mockResolvedValueOnce({
      size: 1,
      points: [{ period: 0, cumulativeNetUsd: 10 }],
    });

    await readChartSeries("proj_1", "retention_curve", WEEK_GRAIN_WINDOW);
    await readChartSeries("proj_1", "ltv", WEEK_GRAIN_WINDOW);

    const [retentionInput] = computeRetentionMock.mock.calls[0] as [
      { rule: unknown; granularity: string; periods: number },
    ];
    const [ltvInput] = computeCohortLtvCurveMock.mock.calls[0] as [
      { rule: unknown; granularity: string; periods: number },
    ];
    expect(ltvInput.rule).toEqual(retentionInput.rule);
    expect(ltvInput.granularity).toBe(retentionInput.granularity);
    expect(ltvInput.periods).toBe(retentionInput.periods);
  });

  it("requires ClickHouse configured", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    await expect(
      readChartSeries("proj_1", "retention_curve", WEEK_GRAIN_WINDOW),
    ).rejects.toThrow();
    await expect(
      readChartSeries("proj_1", "ltv", WEEK_GRAIN_WINDOW),
    ).rejects.toThrow();
  });
});
