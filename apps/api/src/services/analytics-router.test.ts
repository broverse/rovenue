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
    });

    const sqlText = sql as string;
    expect(sqlText).toContain("attributed_conversions");
    expect(sqlText).toContain("experimentKey = {experimentKey:String}");
    // The existing post-exposure heuristic column stays untouched.
    expect(sqlText).toContain("ifNull(c.conversions, 0) AS conversions");
    expect(sqlText).toMatch(
      /raw_revenue_events\s+WHERE\s+projectId = \{projectId:String\}\s+AND experimentKey = \{experimentKey:String\}/,
    );
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
