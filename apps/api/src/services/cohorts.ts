import type {
  CohortFilter,
  CohortRetentionPoint,
  CohortRetentionResponse,
  CohortRule,
} from "@rovenue/shared";
import {
  ClickHouseUnavailableError,
  isClickHouseConfigured,
  queryAnalytics,
} from "../lib/clickhouse";

// =============================================================
// Cohorts service (Phase 4.4)
// =============================================================
//
// Compiles a `CohortRule` to a CH WHERE-clause + parameter bag
// then runs the retention query against `raw_revenue_events`. A
// cohort member is any subscriber whose first INITIAL/RENEWAL
// event matches the rule's filters; retention at period N counts
// how many of those members had any revenue activity in that
// period bucket.
//
// The rule compiler is intentionally restrictive: every operand
// reaches CH via `query_params` so the wire body can never inject
// SQL even if a rule somehow bypasses the route's Zod gate.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PERIODS = 24;

interface CompiledRule {
  /** SQL fragment compatible with raw_revenue_events FROM-clause. */
  whereSql: string;
  params: Record<string, unknown>;
}

const FIELD_TO_COLUMN: Record<CohortFilter["field"], string> = {
  country: "''", // placeholder — raw_revenue_events has no country today
  store: "store",
  productId: "productId",
  purchaseType: "type",
  firstSeenAfter: "eventDate",
  firstSeenBefore: "eventDate",
};

type ParamKind =
  | "String"
  | "Array(String)"
  | "Decimal(12,4)"
  | "Date"
  | "DateTime64(3)";

function compileFilter(
  filter: CohortFilter,
  i: number,
): { sql: string; params: Record<string, unknown>; chKind: ParamKind } | null {
  const column = FIELD_TO_COLUMN[filter.field];
  if (!column) return null;
  // country isn't tracked on raw_revenue_events yet — silently
  // drop the filter so the cohort still resolves. When we add the
  // column the compiler will start respecting it without a route
  // change.
  if (filter.field === "country") return null;

  const p1 = `cv_${i}_a`;
  const p2 = `cv_${i}_b`;

  switch (filter.op) {
    case "eq": {
      if (typeof filter.value !== "string" && typeof filter.value !== "number") {
        return null;
      }
      return {
        sql: `${column} = {${p1}:String}`,
        params: { [p1]: String(filter.value) },
        chKind: "String",
      };
    }
    case "in": {
      if (!Array.isArray(filter.value)) return null;
      return {
        sql: `${column} IN ({${p1}:Array(String)})`,
        params: { [p1]: filter.value.map(String) },
        chKind: "Array(String)",
      };
    }
    case "gte":
    case "lte": {
      if (typeof filter.value !== "number" && typeof filter.value !== "string") {
        return null;
      }
      const cmp = filter.op === "gte" ? ">=" : "<=";
      if (
        filter.field === "firstSeenAfter" ||
        filter.field === "firstSeenBefore"
      ) {
        const fixedCmp = filter.field === "firstSeenAfter" ? ">=" : "<=";
        return {
          sql: `${column} ${fixedCmp} {${p1}:DateTime64(3)}`,
          params: { [p1]: String(filter.value) },
          chKind: "DateTime64(3)",
        };
      }
      return {
        sql: `${column} ${cmp} {${p1}:String}`,
        params: { [p1]: String(filter.value) },
        chKind: "String",
      };
    }
    case "between": {
      if (
        typeof filter.value !== "object" ||
        filter.value === null ||
        Array.isArray(filter.value)
      ) {
        return null;
      }
      const v = filter.value as { min: number; max: number };
      if (typeof v.min !== "number" || typeof v.max !== "number") return null;
      return {
        sql: `${column} BETWEEN {${p1}:Decimal(12,4)} AND {${p2}:Decimal(12,4)}`,
        params: { [p1]: v.min, [p2]: v.max },
        chKind: "Decimal(12,4)",
      };
    }
    default:
      return null;
  }
}

export function compileRule(rule: CohortRule): CompiledRule {
  const fragments: string[] = [];
  const params: Record<string, unknown> = {};
  rule.filters.forEach((f, i) => {
    const compiled = compileFilter(f, i);
    if (!compiled) return;
    fragments.push(`(${compiled.sql})`);
    Object.assign(params, compiled.params);
  });
  if (fragments.length === 0) {
    return { whereSql: "1 = 1", params };
  }
  const joiner = rule.match === "any" ? " OR " : " AND ";
  return { whereSql: fragments.join(joiner), params };
}

// =============================================================
// Retention
// =============================================================
//
// Step 1: derive cohort membership — subscribers whose first
//         revenue event matches the rule.
// Step 2: bucket those subscribers' subsequent revenue events
//         into period N relative to their activation, and count
//         distinct subscribers active per bucket.
//
// Period granularity defaults to "month"; "week" / "day" are
// available for shorter cohorts. CH's `toStartOfMonth` /
// `toMonday` / `toStartOfDay` keep the bucketing arithmetic on
// the analytics side rather than in JS.

interface ChCohortMember {
  subscriberId: string;
  joined_at: string;
}

interface ChRetentionRow {
  period: string;
  active: string;
}

export interface ComputeRetentionInput {
  projectId: string;
  rule: CohortRule;
  granularity: "day" | "week" | "month";
  periods: number;
}

export async function computeRetention(
  input: ComputeRetentionInput,
): Promise<CohortRetentionResponse> {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }
  const periods = Math.min(Math.max(input.periods, 1), MAX_PERIODS);
  const granularity = input.granularity;
  const compiled = compileRule(input.rule);

  // Membership: distinct subscribers + their first matching event.
  const members = await queryAnalytics<ChCohortMember>(
    input.projectId,
    `
      WITH matches AS (
        SELECT subscriberId, min(eventDate) AS joined_at
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND (${compiled.whereSql})
        GROUP BY subscriberId
      )
      SELECT subscriberId,
             formatDateTime(joined_at, '%Y-%m-%dT%H:%i:%S.%fZ') AS joined_at
      FROM matches
    `,
    compiled.params,
  );

  const size = members.length;
  if (size === 0) {
    return {
      size: 0,
      granularity,
      periods,
      points: Array.from({ length: periods }, (_, i) => ({
        period: i,
        active: 0,
        pct: 0,
      })),
    };
  }

  const memberIds = members.map((m) => m.subscriberId);
  const bucketFn =
    granularity === "month"
      ? "toStartOfMonth"
      : granularity === "week"
        ? "toMonday"
        : "toStartOfDay";
  const intervalFn =
    granularity === "month"
      ? "dateDiff('month'"
      : granularity === "week"
        ? "dateDiff('week'"
        : "dateDiff('day'";

  // We re-join member subscriberIds inside CH to compute period
  // index relative to each member's join bucket. The `joined_at`
  // is materialised on the fly via the matches CTE; CH's MV
  // pre-aggregations only carry per-day rollups, so we go to
  // raw_revenue_events for individual events here.
  const retention = await queryAnalytics<ChRetentionRow>(
    input.projectId,
    `
      WITH members AS (
        SELECT subscriberId,
               ${bucketFn}(min(eventDate)) AS join_bucket
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND subscriberId IN ({memberIds:Array(String)})
          AND (${compiled.whereSql})
        GROUP BY subscriberId
      )
      SELECT
        toString(${intervalFn}, m.join_bucket, ${bucketFn}(e.eventDate))) AS period,
        toString(uniqExact(e.subscriberId)) AS active
      FROM rovenue.raw_revenue_events AS e FINAL
      JOIN members AS m ON e.subscriberId = m.subscriberId
      WHERE e.projectId = {projectId:String}
        AND ${bucketFn}(e.eventDate) >= m.join_bucket
        AND ${intervalFn}, m.join_bucket, ${bucketFn}(e.eventDate)) < {periods:UInt32}
      GROUP BY period
      ORDER BY toInt32(period) ASC
    `,
    {
      ...compiled.params,
      memberIds,
      periods,
    },
  );

  const byPeriod = new Map(
    retention.map((r) => [Number(r.period), Number(r.active)]),
  );

  const points: CohortRetentionPoint[] = [];
  for (let p = 0; p < periods; p++) {
    const active = byPeriod.get(p) ?? 0;
    points.push({
      period: p,
      active,
      pct: size > 0 ? Math.round((active / size) * 1000) / 10 : 0,
    });
  }

  return { size, granularity, periods, points };
}

// =============================================================
// The /charts catalog's fixed cohort
// =============================================================
//
// `retention_curve` and `ltv` are catalog charts, not cohort-builder
// queries: they arrive with a window and nothing else. Both use the
// SAME cohort — everyone whose first revenue event falls inside the
// selected window — so the two panels can be read side by side, and so
// neither invents a question the user did not ask. Arbitrary rules
// stay on /cohorts, which is what the rule builder is for.
//
// Granularity follows the window rather than being fixed, because 12
// DAILY periods out of a 12-month window would describe the first
// fortnight of a year and call it a retention curve.
const DAY_GRAIN_MAX_DAYS = 62;
const WEEK_GRAIN_MAX_DAYS = 186;
const CATALOG_COHORT_PERIODS = 12;

export function catalogCohortShape(windowDays: number): {
  granularity: "day" | "week" | "month";
  periods: number;
} {
  const granularity =
    windowDays <= DAY_GRAIN_MAX_DAYS
      ? "day"
      : windowDays <= WEEK_GRAIN_MAX_DAYS
        ? "week"
        : "month";
  return { granularity, periods: CATALOG_COHORT_PERIODS };
}

/**
 * ClickHouse's own DateTime64 literal format. `Date.toISOString()`'s
 * `T` separator and trailing `Z` are not it, and a parameter CH cannot
 * parse fails the whole query rather than the one filter.
 */
function toChDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export function catalogCohortRule(from: Date, to: Date): CohortRule {
  return {
    match: "all",
    filters: [
      { field: "firstSeenAfter", op: "gte", value: toChDateTime(from) },
      { field: "firstSeenBefore", op: "lte", value: toChDateTime(to) },
    ],
  };
}

// =============================================================
// Cohort LTV curve
// =============================================================

export interface CohortLtvCurve {
  /** Cohort size — the denominator every point divides by. */
  size: number;
  points: Array<{ period: number; cumulativeNetUsd: number }>;
}

/**
 * The cohort's CUMULATIVE net revenue at each period since join — the
 * standard LTV curve, and the honest shape for the catalog's `ltv` id
 * (whose own label has always read "LTV by cohort").
 *
 * `v_revenue_lifetime_subscriber` cannot answer this and never could:
 * it groups by (projectId, subscriberId) with no day dimension at all,
 * so it is a lifetime-to-date snapshot with no "when". This reads
 * `raw_revenue_events` directly, exactly as `computeRetention` above
 * does, and buckets by `dateDiff` from each member's join bucket.
 *
 * Net = purchases minus refunds/chargebacks, the same sign convention
 * as `mv_mrr_daily` (migration 0006). `FINAL` retained for the same
 * at-least-once-outbox reason as every other raw_revenue_events reader.
 *
 * The running total is accumulated in TypeScript rather than as a SQL
 * window function, following buildRatePoints' rule in charts.ts: this
 * repo cannot run ClickHouse in unit tests, so arithmetic that lives
 * outside SQL is arithmetic that can be proven.
 */
export async function computeCohortLtvCurve(
  input: ComputeRetentionInput,
): Promise<CohortLtvCurve> {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }
  const periods = Math.min(Math.max(input.periods, 1), MAX_PERIODS);
  const compiled = compileRule(input.rule);

  const members = await queryAnalytics<ChCohortMember>(
    input.projectId,
    `
      WITH matches AS (
        SELECT subscriberId, min(eventDate) AS joined_at
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND (${compiled.whereSql})
        GROUP BY subscriberId
      )
      SELECT subscriberId,
             formatDateTime(joined_at, '%Y-%m-%dT%H:%i:%S.%fZ') AS joined_at
      FROM matches
    `,
    compiled.params,
  );

  const size = members.length;
  if (size === 0) {
    return {
      size: 0,
      points: Array.from({ length: periods }, (_, i) => ({
        period: i,
        cumulativeNetUsd: 0,
      })),
    };
  }

  const memberIds = members.map((m) => m.subscriberId);
  const bucketFn =
    input.granularity === "month"
      ? "toStartOfMonth"
      : input.granularity === "week"
        ? "toMonday"
        : "toStartOfDay";
  const intervalFn =
    input.granularity === "month"
      ? "dateDiff('month'"
      : input.granularity === "week"
        ? "dateDiff('week'"
        : "dateDiff('day'";

  const rows = await queryAnalytics<{ period: string; net_usd: string }>(
    input.projectId,
    `
      WITH members AS (
        SELECT subscriberId,
               ${bucketFn}(min(eventDate)) AS join_bucket
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND subscriberId IN ({memberIds:Array(String)})
          AND (${compiled.whereSql})
        GROUP BY subscriberId
      )
      SELECT
        toString(${intervalFn}, m.join_bucket, ${bucketFn}(e.eventDate))) AS period,
        toString(
          sumIf(e.amountUsd, e.type NOT IN ('REFUND','CHARGEBACK'))
          - sumIf(e.amountUsd, e.type IN ('REFUND','CHARGEBACK'))
        ) AS net_usd
      FROM rovenue.raw_revenue_events AS e FINAL
      JOIN members AS m ON e.subscriberId = m.subscriberId
      WHERE e.projectId = {projectId:String}
        AND ${bucketFn}(e.eventDate) >= m.join_bucket
        AND ${intervalFn}, m.join_bucket, ${bucketFn}(e.eventDate)) < {periods:UInt32}
      GROUP BY period
      ORDER BY toInt32(period) ASC
    `,
    {
      ...compiled.params,
      memberIds,
      periods,
    },
  );

  const byPeriod = new Map(rows.map((r) => [Number(r.period), Number(r.net_usd)]));

  const points: CohortLtvCurve["points"] = [];
  let cumulative = 0;
  for (let p = 0; p < periods; p++) {
    cumulative += byPeriod.get(p) ?? 0;
    points.push({ period: p, cumulativeNetUsd: cumulative });
  }

  return { size, points };
}

export const __cohortsConstants = {
  MAX_PERIODS,
  DAY_MS,
  DAY_GRAIN_MAX_DAYS,
  WEEK_GRAIN_MAX_DAYS,
  CATALOG_COHORT_PERIODS,
};
