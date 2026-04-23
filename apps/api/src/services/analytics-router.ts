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

export interface ExperimentDailyRow {
  experiment_id: string;
  variant_id: string;
  day: string;
  country: string;
  platform: string;
  exposures: number;
  unique_users: number;
}

export async function runAnalyticsQuery(
  q: AnalyticsQuery,
): Promise<ExperimentDailyRow[]> {
  if (!isClickHouseConfigured()) {
    log.warn("analytics query requested but ClickHouse is unconfigured", {
      kind: q.kind,
    });
    return [];
  }

  switch (q.kind) {
    case "experiment_results":
      return queryAnalytics<ExperimentDailyRow>(
        q.projectId,
        `
          SELECT
            experiment_id,
            variant_id,
            toString(day) AS day,
            country,
            platform,
            sum(exposures) AS exposures,
            uniqMerge(unique_users_state) AS unique_users
          FROM rovenue.mv_experiment_daily
          WHERE experiment_id = {experimentId:String}
          GROUP BY experiment_id, variant_id, day, country, platform
          ORDER BY day, variant_id
        `,
        { experimentId: q.experimentId },
      );
    default: {
      const _exhaustive: never = q.kind;
      throw new Error(`unhandled analytics kind: ${String(_exhaustive)}`);
    }
  }
}
