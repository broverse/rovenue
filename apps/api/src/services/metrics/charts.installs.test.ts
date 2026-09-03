import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dispatch test for `rev_per_install`. Mocks the two OWNING services —
// `listDailyMrr` for the numerator (the same source `arpu` and
// `gross_vs_net` read) and `getInstallsDaily` for the denominator — so
// this file exercises charts.ts's own division and null-handling, not
// their SQL. Same pattern as charts.credits.test.ts: the SQL is
// schema-validated for real elsewhere (schema-contract for the CH half,
// installs.integration.test.ts for the Postgres half).

const listDailyMrrMock = vi.fn();
vi.mock("./mrr", () => ({
  listDailyMrr: (...args: unknown[]) => listDailyMrrMock(...args),
}));

const getInstallsDailyMock = vi.fn();
vi.mock("./installs", () => ({
  getInstallsDaily: (...args: unknown[]) => getInstallsDailyMock(...args),
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
const TODAY = new Date("2026-07-02T00:00:00.000Z");

function mrrRow(netUsd: string, bucket: Date = TODAY) {
  return {
    bucket,
    grossUsd: netUsd,
    refundsUsd: "0",
    netUsd,
    eventCount: 1,
    activeSubscribers: 1,
  };
}

describe("readChartSeries — rev_per_install", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    listDailyMrrMock.mockReset().mockResolvedValue([]);
    getInstallsDailyMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("divides the day's net revenue by the day's installs", async () => {
    listDailyMrrMock.mockResolvedValueOnce([mrrRow("120.00")]);
    getInstallsDailyMock.mockResolvedValueOnce([{ day: "2026-07-02", n: 4 }]);

    const res = await readChartSeries("proj_1", "rev_per_install", 1);

    expect(res.supported).toBe(true);
    expect(res.unit).toBe("money");
    expect(res.points.at(-1)).toMatchObject({
      value: 30,
      numerator: 120,
      denominator: 4,
    });
  });

  it("reports null, not zero, on a day with no installs", async () => {
    // An average over nothing is UNDEFINED, not $0 — the same ruling
    // `arpu` and buildRatePoints already carry.
    listDailyMrrMock.mockResolvedValueOnce([mrrRow("120.00")]);
    getInstallsDailyMock.mockResolvedValueOnce([]);

    const res = await readChartSeries("proj_1", "rev_per_install", 1);

    expect(res.points.at(-1)?.value).toBeNull();
    expect(res.points.at(-1)?.denominator).toBe(0);
  });

  it("reports a measured zero when there were installs but no revenue", async () => {
    listDailyMrrMock.mockResolvedValueOnce([]);
    getInstallsDailyMock.mockResolvedValueOnce([{ day: "2026-07-02", n: 9 }]);

    const res = await readChartSeries("proj_1", "rev_per_install", 1);

    expect(res.points.at(-1)?.value).toBe(0);
    expect(res.points.at(-1)?.denominator).toBe(9);
  });

  it("uses NET revenue, so a refund-heavy day can go negative", async () => {
    listDailyMrrMock.mockResolvedValueOnce([
      {
        bucket: TODAY,
        grossUsd: "10.00",
        refundsUsd: "30.00",
        netUsd: "-20.00",
        eventCount: 2,
        activeSubscribers: 1,
      },
    ]);
    getInstallsDailyMock.mockResolvedValueOnce([{ day: "2026-07-02", n: 2 }]);

    const res = await readChartSeries("proj_1", "rev_per_install", 1);

    expect(res.points.at(-1)?.value).toBe(-10);
  });

  it("keeps every day in the window, not just the days with data", async () => {
    listDailyMrrMock.mockResolvedValueOnce([mrrRow("50.00")]);
    getInstallsDailyMock.mockResolvedValueOnce([{ day: "2026-07-02", n: 5 }]);

    const res = await readChartSeries("proj_1", "rev_per_install", 3);

    expect(res.points).toHaveLength(3);
    expect(res.points.slice(0, 2).every((p) => p.value === null)).toBe(true);
  });

  it("requires ClickHouse configured — the numerator is a CH read", async () => {
    isClickHouseConfiguredMock.mockReturnValue(false);
    await expect(
      readChartSeries("proj_1", "rev_per_install", 1),
    ).rejects.toThrow();
  });
});
