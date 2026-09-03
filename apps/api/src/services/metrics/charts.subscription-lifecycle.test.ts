import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dispatch tests for the four subscription-lifecycle chart-series ids
// (new_subs, reactivations, trials_started, churn) — task 3.
//
// new_subs/reactivations delegate to mrr-decomposition.ts's
// getMrrDecompositionDailyCounts (ClickHouse); mocking that function
// directly (rather than queryAnalytics underneath it) keeps this file
// focused on charts.ts's own dispatch/reshaping logic, which is what it
// owns — the SQL itself is schema-validated for real in
// schema-contract.integration.test.ts and pinned/widened in
// subscription-lifecycle-daily.integration.test.ts, never with a mock.
//
// trials_started/churn delegate to summary.ts's getTrialStartsDaily /
// getChurnDaily, which are Postgres (drizzle), not ClickHouse — mocked
// the same way for the same reason.
//
// trial_to_paid (task 4) delegates to summary.ts's
// getTrialConversionsDaily, which IS ClickHouse (unlike its two
// siblings above) — see its doc comment in summary.ts for why it ships
// as a count, not a rate.

const getMrrDecompositionDailyCountsMock = vi.fn();
vi.mock("./mrr-decomposition", () => ({
  getMrrDecompositionDailyCounts: (...args: unknown[]) =>
    getMrrDecompositionDailyCountsMock(...args),
}));

const getTrialStartsDailyMock = vi.fn();
const getChurnDailyMock = vi.fn();
const getTrialConversionsDailyMock = vi.fn();
vi.mock("./summary", () => ({
  getTrialStartsDaily: (...args: unknown[]) => getTrialStartsDailyMock(...args),
  getChurnDaily: (...args: unknown[]) => getChurnDailyMock(...args),
  getTrialConversionsDaily: (...args: unknown[]) =>
    getTrialConversionsDailyMock(...args),
}));

const isClickHouseConfiguredMock = vi.fn();
vi.mock("../../lib/clickhouse", () => ({
  isClickHouseConfigured: (...args: unknown[]) =>
    isClickHouseConfiguredMock(...args),
  queryAnalytics: vi.fn(),
  ClickHouseUnavailableError: class ClickHouseUnavailableError extends Error {},
}));

import { readChartSeries } from "./charts";

const FROZEN_NOW = new Date("2026-07-02T12:00:00.000Z");

describe("readChartSeries — subscription-lifecycle ids", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    getMrrDecompositionDailyCountsMock.mockReset().mockResolvedValue({
      newSubs: [],
      reactivations: [],
    });
    getTrialStartsDailyMock.mockReset().mockResolvedValue([]);
    getChurnDailyMock.mockReset().mockResolvedValue([]);
    getTrialConversionsDailyMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("new_subs: unit is count, values come from the newSubs daily counts", async () => {
    getMrrDecompositionDailyCountsMock.mockResolvedValueOnce({
      newSubs: [{ day: "2026-07-02", n: 3 }],
      reactivations: [],
    });
    const res = await readChartSeries("proj_1", "new_subs", 1);
    expect(res.unit).toBe("count");
    expect(res.supported).toBe(true);
    expect(res.points.at(-1)?.value).toBe(3);
  });

  it("new_subs: requires ClickHouse configured", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    await expect(readChartSeries("proj_1", "new_subs", 1)).rejects.toThrow();
  });

  it("reactivations: unit is count, values come from the reactivations daily counts", async () => {
    getMrrDecompositionDailyCountsMock.mockResolvedValueOnce({
      newSubs: [],
      reactivations: [{ day: "2026-07-02", n: 5 }],
    });
    const res = await readChartSeries("proj_1", "reactivations", 1);
    expect(res.unit).toBe("count");
    expect(res.points.at(-1)?.value).toBe(5);
  });

  it("trials_started: unit is count, values come from getTrialStartsDaily, no ClickHouse required", async () => {
    getTrialStartsDailyMock.mockResolvedValueOnce([{ day: "2026-07-02", n: 2 }]);
    isClickHouseConfiguredMock.mockReturnValue(false);
    const res = await readChartSeries("proj_1", "trials_started", 1);
    expect(res.unit).toBe("count");
    expect(res.supported).toBe(true);
    expect(res.points.at(-1)?.value).toBe(2);
  });

  it("a day absent from the daily counts is a real zero, not null", async () => {
    getMrrDecompositionDailyCountsMock.mockResolvedValueOnce({
      newSubs: [],
      reactivations: [],
    });
    const res = await readChartSeries("proj_1", "new_subs", 1);
    expect(res.points.at(-1)?.value).toBe(0);
  });

  // FIX (task-3 round 1): churn used to be `unit: "percent"`, dividing
  // each day's churn count by a CONSTANT (the project's present-day
  // active-subscriber snapshot) applied to every day in the window —
  // caught in review as a rate label on what was actually a daily count
  // rescaled by an unrelated, undated denominator. Now a plain count,
  // same shape as new_subs/reactivations/trials_started. See
  // summary.ts's getChurnDaily doc comment for the corrected reasoning
  // and what a real per-day rate would need.

  it("churn: unit is count, no ClickHouse required, values come from getChurnDaily", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    getChurnDailyMock.mockResolvedValueOnce([{ day: "2026-07-02", n: 4 }]);
    const res = await readChartSeries("proj_1", "churn", 1);
    expect(res.unit).toBe("count");
    expect(res.supported).toBe(true);
    expect(res.points.at(-1)?.value).toBe(4);
  });

  it("churn: a day absent from getChurnDaily's rows is a real, measured zero", async () => {
    getChurnDailyMock.mockResolvedValueOnce([]);
    const res = await readChartSeries("proj_1", "churn", 1);
    expect(res.points.at(-1)?.value).toBe(0);
    expect(res.points.at(-1)?.value).not.toBeNull();
  });

  // task 4: trial_to_paid — a daily COUNT of TRIAL_CONVERSION events,
  // ClickHouse (unlike trials_started/churn just above). See
  // getTrialConversionsDaily's doc comment in summary.ts for why this
  // isn't a rate divided by getTrialStartsDaily.

  it("trial_to_paid: unit is count, values come from getTrialConversionsDaily, requires ClickHouse", async () => {
    getTrialConversionsDailyMock.mockResolvedValueOnce([
      { day: "2026-07-02", n: 6 },
    ]);
    const res = await readChartSeries("proj_1", "trial_to_paid", 1);
    expect(res.unit).toBe("count");
    expect(res.supported).toBe(true);
    expect(res.points.at(-1)?.value).toBe(6);
  });

  it("trial_to_paid: a day absent from getTrialConversionsDaily's rows is a real, measured zero", async () => {
    getTrialConversionsDailyMock.mockResolvedValueOnce([]);
    const res = await readChartSeries("proj_1", "trial_to_paid", 1);
    expect(res.points.at(-1)?.value).toBe(0);
    expect(res.points.at(-1)?.value).not.toBeNull();
  });

  it("trial_to_paid: requires ClickHouse configured", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    await expect(readChartSeries("proj_1", "trial_to_paid", 1)).rejects.toThrow();
  });
});
