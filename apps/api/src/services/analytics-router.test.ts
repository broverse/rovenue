import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// analytics-router query-shape unit test
// =============================================================
//
// Mocks the ClickHouse module boundary (matches the convention in
// placement-metrics.test.ts / workers/refund-shield-responder.test.ts —
// no live ClickHouse). Asserts the `experiment_results` query passes
// `experimentKey` as a bound param and the SQL body carries the new
// `attributed_conversions` projection, without asserting the full SQL
// text verbatim (too brittle).

const isClickHouseConfiguredMock = vi.fn();
const queryAnalyticsMock = vi.fn();

vi.mock("../lib/clickhouse", () => ({
  isClickHouseConfigured: (...args: unknown[]) =>
    isClickHouseConfiguredMock(...args),
  queryAnalytics: (...args: unknown[]) => queryAnalyticsMock(...args),
}));

import { runAnalyticsQuery } from "./analytics-router";
import { MATURATION_WINDOW_DAYS } from "../lib/experiment-constants";

describe("runAnalyticsQuery — experiment_results", () => {
  beforeEach(() => {
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    queryAnalyticsMock.mockReset().mockResolvedValue([]);
  });

  it("binds experimentKey (not just experimentId) and projects attributed_conversions", async () => {
    await runAnalyticsQuery({
      kind: "experiment_results",
      experimentId: "exp_1",
      experimentKey: "checkout_paywall_v2",
      projectId: "proj_1",
    });

    expect(queryAnalyticsMock).toHaveBeenCalledTimes(1);
    const call = queryAnalyticsMock.mock.calls[0] as [string, string, unknown];
    const [projectId, sql, params] = call;
    expect(projectId).toBe("proj_1");
    expect(params).toEqual({
      projectId: "proj_1",
      experimentId: "exp_1",
      experimentKey: "checkout_paywall_v2",
      windowDays: MATURATION_WINDOW_DAYS,
    });

    const sqlText = sql as string;
    expect(sqlText).toContain("attributed_conversions");
    expect(sqlText).toContain("experimentKey = {experimentKey:String}");
    // The existing post-exposure heuristic column stays untouched.
    expect(sqlText).toContain("ifNull(c.conversions, 0) AS conversions");
    expect(sqlText).toMatch(
      /raw_revenue_events\s+WHERE\s+projectId = \{projectId:String\}\s+AND experimentKey = \{experimentKey:String\}/,
    );
    // Task 3: subscriber-level windowed value aggregates are bound in.
    expect(sqlText).toContain("{windowDays:UInt16}");
    expect(sqlText).toContain("ifNull(wv.converters, 0) AS converters");
    expect(sqlText).toContain("ifNull(wv.excluded_immature, 0) AS excluded_immature");
    expect(sqlText).toContain("ifNull(wv.excluded_crossover, 0) AS excluded_crossover");
    // FINAL must follow the alias, never precede it (invalid CH syntax).
    expect(sqlText).toContain("raw_revenue_events AS r FINAL");
    expect(sqlText).not.toMatch(/raw_revenue_events\s+FINAL\s+AS\s+r/);
  });

  it("returns [] without querying ClickHouse when unconfigured", async () => {
    isClickHouseConfiguredMock.mockReturnValueOnce(false);
    const rows = await runAnalyticsQuery({
      kind: "experiment_results",
      experimentId: "exp_1",
      experimentKey: "checkout_paywall_v2",
      projectId: "proj_1",
    });
    expect(rows).toEqual([]);
    expect(queryAnalyticsMock).not.toHaveBeenCalled();
  });
});

describe("runAnalyticsQuery — placement_metrics", () => {
  beforeEach(() => {
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    queryAnalyticsMock.mockReset().mockResolvedValue([]);
  });

  it("counts views replay-safely (uniqExact over raw, kind='view'), not via the SummingMergeTree rollup", async () => {
    await runAnalyticsQuery({
      kind: "placement_metrics",
      placementId: "plc_1",
      projectId: "proj_1",
    });

    expect(queryAnalyticsMock).toHaveBeenCalledTimes(1);
    const call = queryAnalyticsMock.mock.calls[0] as [string, string, unknown];
    const [projectId, sql, params] = call;
    expect(projectId).toBe("proj_1");
    expect(params).toEqual({ projectId: "proj_1", placementId: "plc_1" });

    const sqlText = sql as string;
    // views = query-time idempotent count over the deduped raw table
    // (0012/0016 pattern): an outbox/Kafka replay of the same eventId
    // must collapse BEFORE counting.
    expect(sqlText).toMatch(
      /uniqExact\(eventId\) AS views\s+FROM rovenue\.raw_paywall_events\s+WHERE projectId = \{projectId:String\}\s+AND placementId = \{placementId:String\}\s+AND kind = 'view'/,
    );
    // The inflating SummingMergeTree read must be gone.
    expect(sqlText).not.toContain("sum(views)");
    // unique_views stays on the replay-safe HLL from the rollup target.
    expect(sqlText).toMatch(
      /uniqMerge\(subscribersHll\)\s+AS unique_views\s+FROM rovenue\.mv_paywall_daily_target/,
    );
    // purchases attribution over raw_revenue_events is untouched.
    expect(sqlText).toContain("uniq(subscriberId) AS purchases");
  });
});
