import { queryAnalytics, isClickHouseConfigured } from "../lib/clickhouse";
import { logger } from "../lib/logger";

// =============================================================
// Analytics router dispatcher
// =============================================================
//
// Source: superseded plan `docs/superpowers/plans/
// 2026-04-23-clickhouse-foundation-and-experiments.md` Task 5.2,
// copied verbatim per Phase F.6 of the Kafka+outbox pivot. Reads
// aggregate queries from ClickHouse when configured; silently
// returns an empty result set otherwise so the caller (e.g.
// `computeExperimentResults`) can degrade gracefully.
//
// Placed under `services/` rather than `routes/` because it is a
// typed dispatcher — not a Hono route. The Phase F.4 experiment
// results service imports `./analytics-router` from this path.

const log = logger.child("analytics-router");

// Plan 1 ships one query kind. Plan 2 adds MRR / cohort / funnel /
// LTV / geo / event-timeline kinds. Each kind has an exhaustive
// switch branch; unknown kinds are a compile-time error thanks to
// the `never` exhaustiveness helper.
export type AnalyticsQuery =
  | {
      kind: "experiment_results";
      experimentId: string;
      projectId: string;
      /** Optional stratification dimensions. */
      groupBy?: Array<"country" | "platform">;
    }
  | {
      kind: "placement_metrics";
      placementId: string;
      projectId: string;
    };

export interface ExperimentVariantRow {
  variant_id: string;
  /** Distinct exposure events (replay-safe via uniqExact on eventId). */
  exposures: number;
  /** Distinct exposed subscribers — the correct A/B denominator. */
  unique_users: number;
  /** Distinct exposed subscribers who had a purchase-class revenue event
   *  at or after their first exposure to this variant. */
  conversions: number;
}

/**
 * String-typed UInt64 aggregates (matches engagement.ts / mrr-decomposition.ts —
 * every field wrapped in `toString()` in the SQL so large counters never
 * round-trip through the client's 64-bit-integer JSON handling; converted
 * back to `Number` by the caller).
 */
export interface PlacementMetricsRow {
  views: string;
  unique_views: string;
  purchases: string;
}

export async function runAnalyticsQuery(
  q: Extract<AnalyticsQuery, { kind: "experiment_results" }>,
): Promise<ExperimentVariantRow[]>;
export async function runAnalyticsQuery(
  q: Extract<AnalyticsQuery, { kind: "placement_metrics" }>,
): Promise<PlacementMetricsRow[]>;
export async function runAnalyticsQuery(
  q: AnalyticsQuery,
): Promise<ExperimentVariantRow[] | PlacementMetricsRow[]> {
  if (!isClickHouseConfigured()) {
    log.warn("analytics query requested but ClickHouse is unconfigured", {
      kind: q.kind,
    });
    return [];
  }

  switch (q.kind) {
    case "experiment_results":
      // One row per variant: exposures + exposed-user denominator + the
      // post-exposure conversion count (a query-time join with
      // raw_revenue_events — no separate MV, so no MV-recreate Kafka-gap
      // risk). Scoped by projectId for tenant isolation. Validated against
      // the live ClickHouse schema (raw_exposures / raw_revenue_events).
      return queryAnalytics<ExperimentVariantRow>(
        q.projectId,
        `
          SELECT
            exp.variantId AS variant_id,
            exp.exposures AS exposures,
            exp.unique_users AS unique_users,
            ifNull(c.conversions, 0) AS conversions
          FROM (
            SELECT
              variantId,
              uniqExact(eventId) AS exposures,
              uniq(subscriberId) AS unique_users
            FROM rovenue.raw_exposures
            WHERE projectId = {projectId:String}
              AND experimentId = {experimentId:String}
            GROUP BY variantId
          ) exp
          LEFT JOIN (
            SELECT e.variantId AS variantId, uniq(e.subscriberId) AS conversions
            FROM (
              SELECT variantId, subscriberId, min(exposedAt) AS firstExposedAt
              FROM rovenue.raw_exposures
              WHERE projectId = {projectId:String}
                AND experimentId = {experimentId:String}
              GROUP BY variantId, subscriberId
            ) e
            INNER JOIN rovenue.raw_revenue_events r
              ON r.subscriberId = e.subscriberId
            WHERE r.projectId = {projectId:String}
              AND r.type IN ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'REACTIVATION')
              AND r.eventDate >= e.firstExposedAt
            GROUP BY e.variantId
          ) c ON exp.variantId = c.variantId
          ORDER BY variant_id
        `,
        { projectId: q.projectId, experimentId: q.experimentId },
      );
    case "placement_metrics":
      // views/unique_views come from the mv_paywall_daily_target rollup
      // (0018_mv_paywall_daily.sql); purchases is a query-time join against
      // raw_paywall_events (no placementId on raw_revenue_events — the
      // dashboard-facing paywall attribution only flows into the paywall-
      // events pipeline, not the revenue one) mirroring the
      // exposure->conversion join above: each subscriber's FIRST view of
      // this placement is matched against their next purchase-class
      // revenue event. `v` and `c` are each a plain (non-GROUP BY) scalar
      // aggregate — deliberately, since GROUP BY on a constant emits ZERO
      // rows for zero matching input rows, whereas a bare aggregate always
      // emits exactly one row of zeros (see summary.ts). Cross-joined
      // (both are always single-row) rather than keyed.
      return queryAnalytics<PlacementMetricsRow>(
        q.projectId,
        `
          SELECT
            toString(v.views)                AS views,
            toString(v.unique_views)          AS unique_views,
            toString(c.purchases)             AS purchases
          FROM (
            SELECT
              sum(views)                 AS views,
              uniqMerge(subscribersHll)  AS unique_views
            FROM rovenue.mv_paywall_daily_target
            WHERE projectId = {projectId:String}
              AND placementId = {placementId:String}
          ) v
          CROSS JOIN (
            SELECT uniq(e.subscriberId) AS purchases
            FROM (
              SELECT subscriberId, min(occurredAt) AS firstViewedAt
              FROM rovenue.raw_paywall_events
              WHERE projectId = {projectId:String}
                AND placementId = {placementId:String}
              GROUP BY subscriberId
            ) e
            INNER JOIN rovenue.raw_revenue_events r
              ON r.subscriberId = e.subscriberId
            WHERE r.projectId = {projectId:String}
              AND r.type IN ('INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'REACTIVATION')
              AND r.eventDate >= e.firstViewedAt
          ) c
        `,
        { projectId: q.projectId, placementId: q.placementId },
      );
    default: {
      // Exhaustiveness check on `q` itself, not `q.kind` — property access
      // on a value TS has narrowed to `never` types as `any` rather than
      // `never`, which defeats this check (verified against tsc 5.9.3;
      // the TS handbook's own exhaustiveness example assigns the whole
      // discriminant-bearing value, not one of its properties).
      const _exhaustive: never = q;
      throw new Error(`unhandled analytics kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
