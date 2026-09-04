import { queryAnalytics, isClickHouseConfigured } from "../lib/clickhouse";
import { MATURATION_WINDOW_DAYS } from "../lib/experiment-constants";
import { logger } from "../lib/logger";
import {
  REVENUE_TYPES_LIFETIME_PURCHASED,
  REVENUE_TYPES_MONEY_OUT,
  sqlTypeList,
} from "@rovenue/shared";

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
      /**
       * The experiment's stable slug (`experiments.key`), NOT the DB id.
       * `raw_revenue_events.experimentKey`/`variantId` (CH migration 0019)
       * are extracted from the SDK's `presentedContext` at purchase time
       * and only ever carry the key — PAYWALL-flow purchases only,
       * OFFERING/FLAG experiment purchases don't have presentedContext.
       */
      experimentKey: string;
      projectId: string;
      /** Optional stratification dimensions. */
      groupBy?: Array<"country" | "platform">;
    }
  | {
      kind: "experiment_revenue_by_store";
      experimentId: string;
      projectId: string;
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
  /** Distinct converting subscribers PRECISELY attributed to this variant
   *  via `raw_revenue_events.experimentKey`/`variantId` (the purchase's own
   *  presentedContext) — no exposure-join heuristic. Only PAYWALL-flow
   *  purchases carry this; 0 for OFFERING/FLAG experiment types. */
  attributed_conversions: number;

  // -----------------------------------------------------------
  // Windowed, subscriber-level value aggregates (decision engine).
  // -----------------------------------------------------------
  //
  // Everything below is computed by folding EACH SUBSCRIBER's revenue
  // events into one net figure first (gross minus refunds over their own
  // MATURATION_WINDOW_DAYS window), THEN aggregating subscribers into
  // variants — never a raw order-level sum. The unit of analysis is the
  // subscriber because the subscriber is the unit of randomisation: an
  // order-level sum would let one subscriber with three renewals count
  // three times in a comparison that randomised subscribers once.
  //
  // A subscriber contributes to exactly one of three buckets per variant:
  // mature (counted below), excluded_immature (their window hasn't
  // elapsed yet), or excluded_crossover (they were exposed to more than
  // one variant of this experiment, so their revenue can't be attributed
  // to either). All three counts are reported — a subscriber that was
  // dropped from the value metrics must be visible, never silently
  // absent.

  /** Subscribers first exposed to this variant whose
   *  MATURATION_WINDOW_DAYS window has fully elapsed AND who were never
   *  exposed to another variant of the same experiment — the denominator
   *  for `converters` and the log-value aggregates below. Distinct from
   *  `unique_users`, which is the un-windowed, unexcluded exposure count
   *  SRM still needs. */
  mature_users: number;
  /** Mature subscribers whose net revenue (gross minus refunds, over
   *  their own window) is strictly positive. DELIBERATE SEMANTIC CHANGE
   *  from `conversions`/`attributed_conversions` above: a subscriber who
   *  purchased and was then fully refunded is NOT a converter here (spec
   *  §4.1) — `conversions` counts the purchase event and does not net
   *  refunds against it. */
  converters: number;
  /** Sum of `log(netRevenue)` over converters only (netRevenue > 0, so
   *  the log is always defined). Sufficient statistic for the Bayesian
   *  value-factor fit in `experiment-bayes.ts`; never computed over a
   *  non-positive value. */
  sum_log_value: number;
  /** Sum of `log(netRevenue)^2` over converters only — paired with
   *  `sum_log_value` to reconstruct the sample variance without shipping
   *  a per-subscriber array. */
  sum_log_value_sq: number;
  /** Sum, over mature subscribers, of their windowed gross revenue
   *  (purchase-class events only: INITIAL/RENEWAL/TRIAL_CONVERSION/
   *  REACTIVATION). Deduplicated against outbox at-least-once replay via
   *  `FINAL` on `raw_revenue_events` BEFORE summing — see the module
   *  header. */
  revenue_usd: number;
  /** Sum, over mature subscribers, of their windowed refunds
   *  (REFUND/CHARGEBACK, `abs()`'d defensively even though the house
   *  convention stores them positive already). */
  refunds_usd: number;
  /** Sum, over ALL mature subscribers, of their windowed NET revenue
   *  (gross minus refunds). Together with `mature_users` and
   *  `net_revenue_sq` these are the sufficient statistics (n, Sum(x),
   *  Sum(x^2)) for a Welch's t-test on raw per-subscriber revenue — the
   *  assumption-free cross-check against the log-normal value model (spec
   *  §4.1). DELIBERATELY over every mature subscriber, not only
   *  converters: the quantity being compared is revenue per USER, and
   *  restricting to converters would condition on an outcome the
   *  experiment influences. Non-converters contribute 0, and a subscriber
   *  who was net-refunded contributes a NEGATIVE amount — which is
   *  correct here and is why this is not derivable from the
   *  converter-only `sum_log_value` pair, whose log is undefined for
   *  non-positive values. */
  net_revenue_usd: number;
  /** Sum, over all mature subscribers, of their windowed net revenue
   *  SQUARED. Paired with `net_revenue_usd` to reconstruct the sample
   *  variance without shipping a per-subscriber array. */
  net_revenue_sq: number;
  /** Count of subscribers first exposed to this variant whose window has
   *  NOT yet elapsed as of query time — excluded from every aggregate
   *  above, reported here so the exclusion is visible rather than a
   *  silently shrunk denominator. */
  excluded_immature: number;
  /** Count of subscribers first exposed to this variant who were ALSO
   *  exposed to at least one other variant of the same experiment
   *  (contamination) — excluded from every aggregate above. A crossover
   *  subscriber is counted once for each variant they touched, since
   *  their revenue can't be cleanly attributed to any single one. */
  excluded_crossover: number;
}

/**
 * One row per (variant, store). Kept as a SEPARATE query/result shape
 * from `ExperimentVariantRow` rather than folded in as a nested array or
 * a `GROUP BY variantId, store` row on the main query, for the same
 * reason `readProceeds` in `services/metrics/charts.ts` treats its own
 * per-store breakdown as a dedicated query: a project can have a
 * commission rate configured for one store and not another, and blending
 * revenue across stores before applying rates would hide which part of
 * the resulting proceeds figure is real and which is undefined. Callers
 * that only need the variant-level metrics (SRM, conversion, ARPU) never
 * pay for the extra JOIN and row fan-out this breakdown requires.
 */
export interface ExperimentStoreRevenueRow {
  variant_id: string;
  store: string;
  /** Same subscriber-level, windowed, crossover/immature-excluded fold as
   *  `ExperimentVariantRow.revenue_usd` — just grouped by store too. */
  revenue_usd: number;
  refunds_usd: number;
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
  q: Extract<AnalyticsQuery, { kind: "experiment_revenue_by_store" }>,
): Promise<ExperimentStoreRevenueRow[]>;
export async function runAnalyticsQuery(
  q: Extract<AnalyticsQuery, { kind: "placement_metrics" }>,
): Promise<PlacementMetricsRow[]>;
export async function runAnalyticsQuery(
  q: AnalyticsQuery,
): Promise<ExperimentVariantRow[] | ExperimentStoreRevenueRow[] | PlacementMetricsRow[]> {
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
      // risk), PLUS the windowed, subscriber-level value aggregates the
      // decision engine consumes (`wv` below). Scoped by projectId for
      // tenant isolation. Validated against the live ClickHouse schema
      // (raw_exposures / raw_revenue_events).
      //
      // `wv`'s CTEs are the load-bearing part of this query — see the
      // `ExperimentVariantRow` doc comment above for the "why" and
      // task-3-report.md for the full design writeup:
      //
      //   - `exposure` collapses each subscriber's exposures to this
      //     experiment down to ONE row per (variant, subscriber), keyed
      //     by their FIRST exposure to that variant.
      //   - `crossover` flags subscribers exposed to more than one
      //     variant — their revenue can't be cleanly attributed to
      //     either, so it's excluded and counted, never silently folded
      //     into one side.
      //   - `per_subscriber` folds each subscriber's revenue events into
      //     ONE net (gross, refunds) pair over their own
      //     MATURATION_WINDOW_DAYS window — BEFORE any cross-subscriber
      //     aggregation, so a subscriber with three renewals counts once,
      //     not three times, in a comparison that randomised subscribers.
      //     `raw_revenue_events` is a ReplacingMergeTree fed by an
      //     at-least-once outbox: a duplicate `eventId` is a real,
      //     visible row until a background merge collapses it, so `AS r
      //     FINAL` deduplicates BEFORE the sum — see migration
      //     0012_idempotent_revenue_aggregates.sql, whose established
      //     pattern this reuses. (`FINAL` must follow the alias:
      //     `raw_revenue_events AS r FINAL`, not `... FINAL AS r`.)
      //   - Every subscriber lands in exactly one of three buckets —
      //     mature / immature / crossover — so `mature_users +
      //     excluded_immature + excluded_crossover` accounts for every
      //     exposed subscriber; nothing is dropped without being counted.
      //   - `amountUsd` is `Decimal(12, 4)`; `log()` needs a float, hence
      //     the explicit `toFloat64()` casts before `log()`/`pow()`.
      //   - `gross - refunds > 0` gates every converter/value aggregate —
      //     a fully-refunded subscriber is not a converter (spec §4.1).
      return queryAnalytics<ExperimentVariantRow>(
        q.projectId,
        `
          WITH exposure AS (
            SELECT variantId, subscriberId, min(exposedAt) AS firstExposedAt
            FROM rovenue.raw_exposures
            WHERE projectId = {projectId:String}
              AND experimentId = {experimentId:String}
            GROUP BY variantId, subscriberId
          ),
          crossover AS (
            -- subscribers seen under more than one variant of this experiment
            SELECT subscriberId
            FROM exposure
            GROUP BY subscriberId
            HAVING uniqExact(variantId) > 1
          ),
          per_subscriber AS (
            -- ClickHouse's default (hash) JOIN only accepts an ON expression
            -- that is a pure equality between left/right columns — an
            -- inequality that spans both tables (the window's date-range
            -- bound, comparing e.firstExposedAt to r.eventDate) is rejected
            -- with INVALID_JOIN_ON_EXPRESSION. So the ON clause carries ONLY
            -- the subscriberId equality; projectId scoping moves into the
            -- right-hand subquery's own WHERE (a single-table filter, safe
            -- anywhere), and the per-subscriber window bound moves into each
            -- sumIf's condition instead, where cross-table comparisons are
            -- unrestricted. This keeps the LEFT JOIN's zero-revenue rows
            -- intact (a subscriber with no purchases, or none inside their
            -- window, still gets a row here with gross = refunds = 0) —
            -- pushing the range check into WHERE instead would silently drop
            -- that subscriber's entire group whenever ALL of their revenue
            -- rows exist but happen to fall outside the window.
            SELECT
              e.variantId AS variantId,
              e.subscriberId AS subscriberId,
              multiIf(
                e.subscriberId IN (SELECT subscriberId FROM crossover), 'crossover',
                e.firstExposedAt + INTERVAL {windowDays:UInt16} DAY > now(), 'immature',
                'mature'
              ) AS bucket,
              -- Ruled IN 2026-09-04: this list excluded CREDIT_PURCHASE, so a paywall
              -- experiment never counted the coin-pack revenue it caused, and would
              -- have gone on to miss one-time purchases too. An experiment's revenue
              -- counts every sale it caused.
              sumIf(
                r.amountUsd,
                r.type IN (${sqlTypeList(REVENUE_TYPES_LIFETIME_PURCHASED)})
                  AND r.eventDate >= e.firstExposedAt
                  AND r.eventDate <  e.firstExposedAt + INTERVAL {windowDays:UInt16} DAY
              ) AS gross,
              sumIf(
                abs(r.amountUsd),
                r.type IN (${sqlTypeList(REVENUE_TYPES_MONEY_OUT)})
                  AND r.eventDate >= e.firstExposedAt
                  AND r.eventDate <  e.firstExposedAt + INTERVAL {windowDays:UInt16} DAY
              ) AS refunds
            FROM exposure e
            LEFT JOIN (
              SELECT subscriberId, type, amountUsd, eventDate
              FROM rovenue.raw_revenue_events AS r FINAL
              WHERE r.projectId = {projectId:String}
            ) AS r
              ON r.subscriberId = e.subscriberId
            GROUP BY e.variantId, e.subscriberId, e.firstExposedAt
          )
          SELECT
            exp.variantId AS variant_id,
            exp.exposures AS exposures,
            exp.unique_users AS unique_users,
            ifNull(c.conversions, 0) AS conversions,
            ifNull(ac.attributed_conversions, 0) AS attributed_conversions,
            -- toUInt32(): count()/countIf() produce UInt64, which the
            -- ClickHouse JSON formats quote as a STRING by default
            -- (output_format_json_quote_64bit_integers) — fine for the
            -- pre-existing UInt64 columns above (callers already Number()
            -- them), but these four are typed as plain numbers on
            -- ExperimentVariantRow and consumed directly by
            -- experiment-bayes.ts, so the cast keeps
            -- them genuinely numeric over the wire instead of pushing a
            -- string/number split onto every caller.
            toUInt32(ifNull(wv.mature_users, 0)) AS mature_users,
            toUInt32(ifNull(wv.converters, 0)) AS converters,
            ifNull(wv.sum_log_value, 0) AS sum_log_value,
            ifNull(wv.sum_log_value_sq, 0) AS sum_log_value_sq,
            ifNull(wv.revenue_usd, 0) AS revenue_usd,
            ifNull(wv.refunds_usd, 0) AS refunds_usd,
            ifNull(wv.net_revenue_usd, 0) AS net_revenue_usd,
            ifNull(wv.net_revenue_sq, 0) AS net_revenue_sq,
            toUInt32(ifNull(wv.excluded_immature, 0)) AS excluded_immature,
            toUInt32(ifNull(wv.excluded_crossover, 0)) AS excluded_crossover
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
              AND r.type IN (${sqlTypeList(REVENUE_TYPES_LIFETIME_PURCHASED)})
              AND r.eventDate >= e.firstExposedAt
            GROUP BY e.variantId
          ) c ON exp.variantId = c.variantId
          LEFT JOIN (
            -- Precise attribution: raw_revenue_events carries the purchase's
            -- own experimentKey/variantId (extracted from presentedContext,
            -- 0019_revenue_presented_context.sql) — no exposure-join
            -- heuristic, no viewer-overlap risk. Keyed by experimentKey (the
            -- stable slug), not experimentId, because that's what the SDK's
            -- presentedContext carries.
            SELECT variantId, uniq(subscriberId) AS attributed_conversions
            FROM rovenue.raw_revenue_events
            WHERE projectId = {projectId:String}
              AND experimentKey = {experimentKey:String}
              AND type IN (${sqlTypeList(REVENUE_TYPES_LIFETIME_PURCHASED)})
            GROUP BY variantId
          ) ac ON exp.variantId = ac.variantId
          LEFT JOIN (
            SELECT
              variantId,
              countIf(bucket = 'mature')                                                                  AS mature_users,
              countIf(bucket = 'mature' AND gross - refunds > 0)                                          AS converters,
              sumIf(log(toFloat64(gross - refunds)), bucket = 'mature' AND gross - refunds > 0)            AS sum_log_value,
              sumIf(pow(log(toFloat64(gross - refunds)), 2), bucket = 'mature' AND gross - refunds > 0)    AS sum_log_value_sq,
              sumIf(toFloat64(gross), bucket = 'mature')                                                   AS revenue_usd,
              sumIf(toFloat64(refunds), bucket = 'mature')                                                 AS refunds_usd,
              -- Welch cross-check sufficient statistics. Same
              -- bucket = 'mature' gate as every aggregate above, but over
              -- ALL mature subscribers rather than converters only: the
              -- quantity is revenue per USER. No positivity gate either,
              -- so a net-refunded subscriber contributes a negative
              -- amount, exactly as a raw per-subscriber series would.
              sumIf(toFloat64(gross - refunds), bucket = 'mature')                                          AS net_revenue_usd,
              sumIf(pow(toFloat64(gross - refunds), 2), bucket = 'mature')                                  AS net_revenue_sq,
              countIf(bucket = 'immature')                                                                 AS excluded_immature,
              countIf(bucket = 'crossover')                                                                AS excluded_crossover
            FROM per_subscriber
            GROUP BY variantId
          ) wv ON exp.variantId = wv.variantId
          ORDER BY variant_id
        `,
        {
          projectId: q.projectId,
          experimentId: q.experimentId,
          experimentKey: q.experimentKey,
          windowDays: MATURATION_WINDOW_DAYS,
        },
      );
    case "experiment_revenue_by_store":
      // Per-store split of the same subscriber-level, windowed, mature-only
      // fold as "experiment_results" above — see `ExperimentStoreRevenueRow`
      // for why this is a separate query rather than folded into the main
      // row. Reuses the identical exposure/crossover/window CTE shape (same
      // dedup-before-sum via `FINAL`, same crossover/immaturity exclusion);
      // duplicated here rather than shared because each is an independent
      // HTTP call to ClickHouse — there is no cross-query CTE reuse.
      // INNER JOIN (not LEFT) because a subscriber with no revenue event in
      // their window contributes nothing to any store's total, so there is
      // no meaningful `store = NULL` row to emit for them.
      return queryAnalytics<ExperimentStoreRevenueRow>(
        q.projectId,
        `
          WITH exposure AS (
            SELECT variantId, subscriberId, min(exposedAt) AS firstExposedAt
            FROM rovenue.raw_exposures
            WHERE projectId = {projectId:String}
              AND experimentId = {experimentId:String}
            GROUP BY variantId, subscriberId
          ),
          crossover AS (
            SELECT subscriberId
            FROM exposure
            GROUP BY subscriberId
            HAVING uniqExact(variantId) > 1
          ),
          per_subscriber_store AS (
            -- Same ON-clause restriction as "experiment_results" above: the
            -- hash JOIN's ON carries ONLY the subscriberId equality. Here the
            -- window bound safely lives in WHERE (not sumIf) because this is
            -- an INNER JOIN specifically meant to drop non-contributing rows
            -- — a subscriber with no windowed revenue in a store has no
            -- meaningful zero-row to emit for that store, unlike the
            -- LEFT JOIN in "experiment_results" which must keep one.
            SELECT
              e.variantId AS variantId,
              e.subscriberId AS subscriberId,
              r.store AS store,
              sumIf(r.amountUsd, r.type IN (${sqlTypeList(REVENUE_TYPES_LIFETIME_PURCHASED)})) AS gross,
              sumIf(abs(r.amountUsd), r.type IN (${sqlTypeList(REVENUE_TYPES_MONEY_OUT)}))                              AS refunds
            FROM exposure e
            INNER JOIN (
              SELECT subscriberId, store, type, amountUsd, eventDate
              FROM rovenue.raw_revenue_events AS r FINAL
              WHERE r.projectId = {projectId:String}
            ) AS r
              ON r.subscriberId = e.subscriberId
            WHERE e.subscriberId NOT IN (SELECT subscriberId FROM crossover)
              AND e.firstExposedAt + INTERVAL {windowDays:UInt16} DAY <= now()
              AND r.eventDate >= e.firstExposedAt
              AND r.eventDate <  e.firstExposedAt + INTERVAL {windowDays:UInt16} DAY
            GROUP BY e.variantId, e.subscriberId, r.store
          )
          SELECT
            variantId               AS variant_id,
            store                   AS store,
            sum(toFloat64(gross))   AS revenue_usd,
            sum(toFloat64(refunds)) AS refunds_usd
          FROM per_subscriber_store
          GROUP BY variantId, store
          ORDER BY variant_id, store
        `,
        {
          projectId: q.projectId,
          experimentId: q.experimentId,
          windowDays: MATURATION_WINDOW_DAYS,
        },
      );
    case "placement_metrics":
      // views is a query-time idempotent count over the deduped raw table
      // (the 0012/0016 pattern): uniqExact(eventId) collapses outbox/Kafka
      // replays of the same eventId BEFORE counting. The former
      // `sum(views)` read of mv_paywall_daily_target (SummingMergeTree,
      // 0018) counted every INSERT — raw_paywall_events is
      // ReplacingMergeTree so the raw table dedupes eventually, but the
      // rollup had already summed the duplicate, permanently inflating the
      // counter on every at-least-once replay. kind = 'view' mirrors the
      // rollup's own filter (0020) so close events are excluded.
      // unique_views stays on the rollup's HLL state — uniqMerge over
      // uniqState is replay-safe by construction (same distinct set), and
      // charts.ts reads the same target, so the MV survives.
      // purchases is PRECISE attribution:
      // raw_revenue_events carries the purchase's presentedContext
      // (placementId column, 0019_revenue_presented_context.sql), so we
      // count unique converting subscribers attributed to THIS placement
      // directly — no viewer-overlap heuristic. Rows ingested before 0019
      // carry '' and simply don't match. `v`, `u` and `c` are each a plain
      // (non-GROUP BY) scalar aggregate — deliberately, since GROUP BY on
      // a constant emits ZERO rows for zero matching input rows, whereas a
      // bare aggregate always emits exactly one row of zeros (see
      // summary.ts). Cross-joined (all are always single-row).
      return queryAnalytics<PlacementMetricsRow>(
        q.projectId,
        `
          SELECT
            toString(v.views)                AS views,
            toString(u.unique_views)          AS unique_views,
            toString(c.purchases)             AS purchases
          FROM (
            SELECT uniqExact(eventId) AS views
            FROM rovenue.raw_paywall_events
            WHERE projectId = {projectId:String}
              AND placementId = {placementId:String}
              AND kind = 'view'
          ) v
          CROSS JOIN (
            SELECT
              uniqMerge(subscribersHll)  AS unique_views
            FROM rovenue.mv_paywall_daily_target
            WHERE projectId = {projectId:String}
              AND placementId = {placementId:String}
          ) u
          CROSS JOIN (
            SELECT uniq(subscriberId) AS purchases
            FROM rovenue.raw_revenue_events
            WHERE projectId = {projectId:String}
              AND placementId = {placementId:String}
              AND type IN (${sqlTypeList(REVENUE_TYPES_LIFETIME_PURCHASED)})
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
