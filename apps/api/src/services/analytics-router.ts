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

export async function runAnalyticsQuery(
  q: AnalyticsQuery,
): Promise<ExperimentVariantRow[]> {
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
    default: {
      const _exhaustive: never = q.kind;
      throw new Error(`unhandled analytics kind: ${String(_exhaustive)}`);
    }
  }
}
