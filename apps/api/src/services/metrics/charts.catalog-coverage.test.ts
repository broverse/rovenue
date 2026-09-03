import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Every system catalog id must have a reader
// =============================================================
//
// A catalog row is rendered in the dashboard's left rail and is
// selectable, so an id with no `case` in `readChartSeries` dead-ends on
// "not wired to a data source". Between 2026-09-02 and 2026-09-04 that
// was the state of four of the sixteen; this test is what keeps the
// seventeenth from shipping the same way. It fails BY NAME.
//
// Every owning service is mocked to an empty result: what is under test
// is DISPATCH COVERAGE, not data. The readers' own behaviour is pinned
// in charts.revenue / charts.paywall / charts.subscription-lifecycle /
// charts.credits / charts.installs / charts.cohorts, and their SQL in
// schema-contract.integration.test.ts and the two Postgres integration
// tests.

vi.mock("../../lib/clickhouse", () => ({
  isClickHouseConfigured: () => true,
  queryAnalytics: vi.fn(async () => []),
  ClickHouseUnavailableError: class ClickHouseUnavailableError extends Error {},
}));

vi.mock("./mrr", () => ({ listDailyMrr: vi.fn(async () => []) }));

vi.mock("./mrr-decomposition", () => ({
  getMrrDecompositionDailyCounts: vi.fn(async () => ({
    newSubs: [],
    reactivations: [],
  })),
}));

vi.mock("./summary", () => ({
  getChurnDaily: vi.fn(async () => []),
  getTrialConversionsDaily: vi.fn(async () => []),
  getTrialStartsDaily: vi.fn(async () => []),
}));

vi.mock("./credits", () => ({
  getCreditBurnDaily: vi.fn(async () => []),
  getCreditLiabilityDaily: vi.fn(async () => []),
}));

vi.mock("./installs", () => ({ getInstallsDaily: vi.fn(async () => []) }));

vi.mock("../cohorts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cohorts")>();
  return {
    ...actual,
    computeRetention: vi.fn(async () => ({
      size: 0,
      granularity: "month" as const,
      periods: 0,
      points: [],
    })),
    computeCohortLtvCurve: vi.fn(async () => ({ size: 0, points: [] })),
  };
});

import { readChartSeries } from "./charts";
import { SYSTEM_CHART_IDS } from "./chart-catalog";

const WINDOW_DAYS = 30;
const PROJECT_ID = "proj_1";

describe("chart-catalog dispatch coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));
    return () => vi.useRealTimers();
  });

  it("every system catalog id is served by the dispatcher", async () => {
    const unwired: string[] = [];
    for (const id of SYSTEM_CHART_IDS) {
      const res = await readChartSeries(PROJECT_ID, id, WINDOW_DAYS);
      if (!res.supported) unwired.push(id);
    }
    expect(
      unwired,
      `Catalog id(s) with no reader in readChartSeries: ${unwired.join(", ")}. ` +
        `The left rail offers these and the panel dead-ends on an empty ` +
        `state — add a case, or take the id out of SYSTEM_CATALOG.`,
    ).toEqual([]);
  });

  it("declares an axis for every id, and only the cohort curves are periods", async () => {
    const periodIds: string[] = [];
    for (const id of SYSTEM_CHART_IDS) {
      const res = await readChartSeries(PROJECT_ID, id, WINDOW_DAYS);
      if (res.axis === "period") periodIds.push(id);
    }
    expect(periodIds.sort()).toEqual(["ltv", "retention_curve"]);
  });

  it("an unknown id is still honestly unsupported, on a date axis", async () => {
    const res = await readChartSeries(PROJECT_ID, "not_a_chart", WINDOW_DAYS);
    expect(res.supported).toBe(false);
    expect(res.axis).toBe("date");
    expect(res.points).toEqual([]);
  });
});
