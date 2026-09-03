import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dispatch test for the credits-group chart-series id (task 5):
// credit_burn. Mocking credits.ts's `getCreditBurnDaily` directly
// (rather than queryAnalytics underneath it) keeps this file focused
// on charts.ts's own dispatch/reshaping logic, same pattern as
// charts.subscription-lifecycle.test.ts — the SQL itself is schema-
// validated for real in schema-contract.integration.test.ts, and the
// existing `getCreditsRollup` consumer of the same underlying query is
// pinned in routes/dashboard/credits.integration.test.ts, never with a
// mock.
//
// `liability` is dispatched here too, from the same service. Its own
// SQL is proven against a real ledger in
// credits.liability-daily.integration.test.ts; what this file pins is
// that the dispatcher serves it, as a Postgres fact, with no ClickHouse
// requirement.

const getCreditBurnDailyMock = vi.fn();
const getCreditLiabilityDailyMock = vi.fn();
vi.mock("./credits", () => ({
  getCreditBurnDaily: (...args: unknown[]) => getCreditBurnDailyMock(...args),
  getCreditLiabilityDaily: (...args: unknown[]) =>
    getCreditLiabilityDailyMock(...args),
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

describe("readChartSeries — credits group (credit_burn)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    getCreditBurnDailyMock.mockReset().mockResolvedValue([]);
    getCreditLiabilityDailyMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("unit is count, not money — credits are a unit of account", async () => {
    getCreditBurnDailyMock.mockResolvedValueOnce([
      { day: "2026-07-02", n: 12 },
    ]);
    const res = await readChartSeries("proj_1", "credit_burn", 1);
    expect(res.unit).toBe("count");
    expect(res.supported).toBe(true);
    expect(res.points.at(-1)?.value).toBe(12);
  });

  it("requires ClickHouse configured", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    await expect(readChartSeries("proj_1", "credit_burn", 1)).rejects.toThrow();
  });

  it("a day absent from the daily rows is a real, measured zero, not null", async () => {
    getCreditBurnDailyMock.mockResolvedValueOnce([]);
    const res = await readChartSeries("proj_1", "credit_burn", 1);
    expect(res.points.at(-1)?.value).toBe(0);
    expect(res.points.at(-1)?.value).not.toBeNull();
  });

  it("passes the dispatcher's window through to getCreditBurnDaily", async () => {
    await readChartSeries("proj_1", "credit_burn", 3);
    expect(getCreditBurnDailyMock).toHaveBeenCalledTimes(1);
    const [projectId, window] = getCreditBurnDailyMock.mock.calls[0] as [
      string,
      { from: Date; to: Date; days: number },
    ];
    expect(projectId).toBe("proj_1");
    expect(window.days).toBe(3);
  });
});

describe("readChartSeries — liability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    getCreditLiabilityDailyMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves the ledger's daily outstanding balance as a count", async () => {
    getCreditLiabilityDailyMock.mockResolvedValueOnce([
      { day: "2026-07-02", n: 95 },
    ]);
    const res = await readChartSeries("proj_1", "liability", 1);
    expect(res.supported).toBe(true);
    // Credits are a unit of account, not USD — same ruling as
    // credit_burn above.
    expect(res.unit).toBe("count");
    expect(res.points.at(-1)?.value).toBe(95);
  });

  it("issues no ClickHouse query — the ledger is Postgres", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    getCreditLiabilityDailyMock.mockResolvedValueOnce([
      { day: "2026-07-02", n: 7 },
    ]);
    const res = await readChartSeries("proj_1", "liability", 1);
    expect(res.supported).toBe(true);
    expect(res.points.at(-1)?.value).toBe(7);
  });

  it("passes the dispatcher's window through to getCreditLiabilityDaily", async () => {
    await readChartSeries("proj_1", "liability", 3);
    expect(getCreditLiabilityDailyMock).toHaveBeenCalledTimes(1);
    const [projectId, window] = getCreditLiabilityDailyMock.mock.calls[0] as [
      string,
      { from: Date; to: Date; days: number },
    ];
    expect(projectId).toBe("proj_1");
    expect(window.days).toBe(3);
  });
});
