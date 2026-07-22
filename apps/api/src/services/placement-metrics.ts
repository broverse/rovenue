import { runAnalyticsQuery } from "./analytics-router";

// =============================================================
// Placement metrics (CH-backed)
// =============================================================
//
// Backs `GET /dashboard/projects/:projectId/placements/:id/metrics`.
// Mirrors experiment-results.ts: a thin wrapper around
// `runAnalyticsQuery` that shapes the raw CH row into the dashboard
// response. `runAnalyticsQuery` already degrades to `[]` when
// ClickHouse is unconfigured (see analytics-router.ts) — this
// service turns that empty array into an explicit all-zero response
// rather than `undefined`, so the dashboard card always has a shape
// to render (local dev with a blank CLICKHOUSE_URL never crashes the
// placement detail page).

export interface PlacementMetrics {
  views: number;
  uniqueViews: number;
  purchases: number;
  /** `purchases / uniqueViews`, or `null` when `uniqueViews` is 0. */
  conversionRate: number | null;
}

const ZERO_METRICS: PlacementMetrics = {
  views: 0,
  uniqueViews: 0,
  purchases: 0,
  conversionRate: null,
};

export async function computePlacementMetrics(
  placementId: string,
  projectId: string,
): Promise<PlacementMetrics> {
  const rows = await runAnalyticsQuery({
    kind: "placement_metrics",
    placementId,
    projectId,
  });
  const row = rows[0];
  if (!row) return ZERO_METRICS;

  const views = Number(row.views) || 0;
  const uniqueViews = Number(row.unique_views) || 0;
  const purchases = Number(row.purchases) || 0;

  return {
    views,
    uniqueViews,
    purchases,
    conversionRate: uniqueViews > 0 ? purchases / uniqueViews : null,
  };
}
