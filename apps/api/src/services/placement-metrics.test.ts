import { describe, expect, it, vi } from "vitest";

// Unit-level, not integration: computePlacementMetrics is a thin shaping
// layer over runAnalyticsQuery, which already owns the ClickHouse-blank
// degrade-to-[] behavior (see analytics-router.ts) and has no existing
// integration test of its own to mirror (experiment-results.ts, the
// closest sibling, is untested at time of writing). Mocking the module
// boundary here matches the codebase's convention for CH-adjacent unit
// tests (see workers/refund-shield-responder.test.ts mocking
// lib/clickhouse) without standing up a real ClickHouse instance.

const runAnalyticsQueryMock = vi.fn();
vi.mock("./analytics-router", () => ({
  runAnalyticsQuery: (...args: unknown[]) => runAnalyticsQueryMock(...args),
}));

import { computePlacementMetrics } from "./placement-metrics";

describe("computePlacementMetrics", () => {
  it("returns all-zero metrics when ClickHouse returns no rows (unconfigured)", async () => {
    runAnalyticsQueryMock.mockResolvedValueOnce([]);

    const result = await computePlacementMetrics("placement_1", "project_1");

    expect(result).toEqual({
      views: 0,
      uniqueViews: 0,
      purchases: 0,
      conversionRate: null,
    });
    expect(runAnalyticsQueryMock).toHaveBeenCalledWith({
      kind: "placement_metrics",
      placementId: "placement_1",
      projectId: "project_1",
    });
  });

  it("converts the string-typed CH row and computes conversionRate", async () => {
    runAnalyticsQueryMock.mockResolvedValueOnce([
      { views: "120", unique_views: "100", purchases: "25" },
    ]);

    const result = await computePlacementMetrics("placement_1", "project_1");

    expect(result).toEqual({
      views: 120,
      uniqueViews: 100,
      purchases: 25,
      conversionRate: 0.25,
    });
  });

  it("returns a null conversionRate when uniqueViews is 0 even with views/purchases present", async () => {
    // Defensive case — shouldn't happen given the join semantics, but
    // the shaping layer must never divide by zero.
    runAnalyticsQueryMock.mockResolvedValueOnce([
      { views: "5", unique_views: "0", purchases: "2" },
    ]);

    const result = await computePlacementMetrics("placement_1", "project_1");

    expect(result.conversionRate).toBeNull();
    expect(result.views).toBe(5);
    expect(result.purchases).toBe(2);
  });
});
