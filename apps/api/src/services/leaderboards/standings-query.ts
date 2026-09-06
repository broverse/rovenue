// =============================================================
// Shared leaderboard standings query
// =============================================================
//
// One SQL body per metric, shared by the scheduler's frozen season
// snapshot and the dashboard's live "/current" view. Two copies of
// this SQL is exactly how a live leaderboard ends up contradicting
// its own archive (see the task-3 brief).
//
// The two query bodies below are lifted verbatim from the existing
// `top-spenders` / `top-consumers` handlers in
// `apps/api/src/routes/dashboard/leaderboards.ts` — same table,
// same FINAL modifier, same debit-sign convention, same tie-break —
// then reparameterised on an instant window instead of a day range:
//
//   - `raw_revenue_events` carries no `createdAt` column; its event
//     time column is `eventDate` (see
//     packages/db/clickhouse/migrations/0004_revenue_kafka_engine.sql).
//   - `raw_credit_ledger` does carry `createdAt`
//     (packages/db/clickhouse/migrations/0005_credit_kafka_engine.sql)
//     and `currencyId`
//     (packages/db/clickhouse/migrations/0015_credit_currency_dimension.sql).
//
// Seasons need instant precision and an exclusive end (a boundary
// event must be counted exactly once), so the window is half-open:
// `>= startsAt AND < endsAt`, unlike the existing day-range routes'
// inclusive `toDate(...) >= from AND <= to`.
import type { LeaderboardMetric } from "@rovenue/db";
import { queryAnalytics } from "../../lib/clickhouse";

export interface StandingRow {
  subscriberId: string;
  score: string;
  eventCount: number;
}

interface RawStandingRow {
  subscriberId: string;
  score: string;
  eventCount: string;
}

export function buildStandingsQuery(
  metric: LeaderboardMetric,
  currencyId: string | null,
): { sql: string } {
  switch (metric) {
    case "TOP_SPENDERS":
      return {
        sql: `
          SELECT
            subscriberId,
            toString(sum(amountUsd)) AS score,
            toString(count())       AS eventCount
          FROM rovenue.raw_revenue_events FINAL
          WHERE projectId = {projectId:String}
            AND eventDate >= {startsAt:DateTime64(3)}
            AND eventDate < {endsAt:DateTime64(3)}
          GROUP BY subscriberId
          ORDER BY sum(amountUsd) DESC, subscriberId ASC
          LIMIT {limit:UInt32}
        `,
      };
    case "TOP_CONSUMERS": {
      const currencyFilter =
        currencyId !== null ? "\n            AND currencyId = {currencyId:String}" : "";
      return {
        sql: `
          SELECT
            subscriberId,
            toString(sumIf(-amount, amount < 0)) AS score,
            toString(countIf(amount < 0))         AS eventCount
          FROM rovenue.raw_credit_ledger FINAL
          WHERE projectId = {projectId:String}
            AND createdAt >= {startsAt:DateTime64(3)}
            AND createdAt < {endsAt:DateTime64(3)}${currencyFilter}
          GROUP BY subscriberId
          HAVING sumIf(-amount, amount < 0) > 0
          ORDER BY sumIf(-amount, amount < 0) DESC, subscriberId ASC
          LIMIT {limit:UInt32}
        `,
      };
    }
    default: {
      const exhaustive: never = metric;
      throw new Error(`buildStandingsQuery: unhandled metric ${exhaustive}`);
    }
  }
}

export async function queryStandings(args: {
  projectId: string;
  metric: LeaderboardMetric;
  currencyId: string | null;
  startsAt: Date;
  endsAt: Date;
  limit: number;
}): Promise<StandingRow[]> {
  const { sql } = buildStandingsQuery(args.metric, args.currencyId);

  const params: Record<string, unknown> = {
    startsAt: args.startsAt,
    endsAt: args.endsAt,
    limit: args.limit,
  };
  if (args.metric === "TOP_CONSUMERS" && args.currencyId !== null) {
    params.currencyId = args.currencyId;
  }

  const rows = await queryAnalytics<RawStandingRow>(args.projectId, sql, params);

  return rows.map((r) => ({
    subscriberId: r.subscriberId,
    score: r.score,
    eventCount: Number(r.eventCount),
  }));
}
