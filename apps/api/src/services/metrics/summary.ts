import { queryAnalytics } from "../../lib/clickhouse";
import { and, eq, gte, inArray, isNotNull, isNull, lte, or, countDistinct, sql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { toDateOnly } from "./_utils";

// =============================================================
// Revenue summary read service — ClickHouse exclusive
// =============================================================
//
// Two CH reads, run in parallel:
//   1. raw_revenue_events window aggregate → gross, refunds,
//      distinct paying subscribers (for ARPPU).
//   2. v_revenue_lifetime_subscriber aggregate → avg/median/p90
//      lifetime net per subscriber (LTV distribution summary).
//
// Money is parsed from CH decimal-strings with Number(), summed,
// and re-emitted via toFixed(4) — same convention as overview.ts.

export interface GetRevenueSummaryInput {
  projectId: string;
  from: Date;
  to: Date;
}

export interface RevenueSummary {
  grossUsd: string;
  refundsUsd: string;
  netUsd: string;
  refundRate: number | null;
  payingSubscribers: number;
  arppu: string | null;
  avgLtvUsd: string;
  medianLtvUsd: string;
  p90LtvUsd: string;
  ltvSubscribers: number;
  activeSubscriberBase: number;
  arpu: string | null;
  churnedInWindow: number;
  churnRate: number | null;
  trialStarts: number;
  trialConversions: number;
  trialConversionRate: number | null;
}

interface ChWindowRow {
  gross_usd: string;
  refunds_usd: string;
  paying_subs: string;
  trial_conversions: string;
}

interface ChLtvRow {
  avg_usd: string;
  median_usd: string;
  p90_usd: string;
  subscribers: string;
}

export async function getRevenueSummary(
  input: GetRevenueSummaryInput,
): Promise<RevenueSummary> {
  const params = {
    from: toDateOnly(input.from),
    to: toDateOnly(input.to),
  };

  const p = drizzle.schema.purchases;
  const [windowRows, ltvRows, activeRow, churnedRow, trialStartRow] = await Promise.all([
    queryAnalytics<ChWindowRow>(
      input.projectId,
      `
        SELECT
          toString(sumIf(amountUsd, type NOT IN ('REFUND','CHARGEBACK')))          AS gross_usd,
          toString(sumIf(abs(amountUsd), type IN ('REFUND','CHARGEBACK')))         AS refunds_usd,
          toString(uniqExactIf(subscriberId, type NOT IN ('REFUND','CHARGEBACK'))) AS paying_subs,
          toString(uniqExactIf(subscriberId, type = 'TRIAL_CONVERSION'))           AS trial_conversions
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND toDate(eventDate) >= {from:Date}
          AND toDate(eventDate) <= {to:Date}
      `,
      params,
    ),
    queryAnalytics<ChLtvRow>(
      input.projectId,
      `
        SELECT
          toString(round(avg(net_cents) / 100, 4))                 AS avg_usd,
          toString(round(quantileExact(0.5)(net_cents) / 100, 4))  AS median_usd,
          toString(round(quantileExact(0.9)(net_cents) / 100, 4))  AS p90_usd,
          toString(count())                                        AS subscribers
        FROM (
          SELECT
            toInt64(lifetime_dollars_purchased_cents)
              - toInt64(lifetime_dollars_refunded_cents)           AS net_cents
          FROM rovenue.v_revenue_lifetime_subscriber
          WHERE projectId = {projectId:String}
        )
      `,
      params,
    ),
    drizzle.db
      .select({ c: countDistinct(p.subscriberId) })
      .from(p)
      .where(and(eq(p.projectId, input.projectId), eq(p.status, "ACTIVE"))),
    drizzle.db
      .select({ c: countDistinct(p.subscriberId) })
      .from(p)
      .where(
        and(
          eq(p.projectId, input.projectId),
          inArray(p.status, ["EXPIRED", "REFUNDED", "REVOKED"]),
          or(
            and(
              isNotNull(p.cancellationDate),
              gte(p.cancellationDate, input.from),
              lte(p.cancellationDate, input.to),
            ),
            and(
              isNull(p.cancellationDate),
              isNotNull(p.expiresDate),
              gte(p.expiresDate, input.from),
              lte(p.expiresDate, input.to),
            ),
          ),
        ),
      ),
    drizzle.db
      .select({ c: countDistinct(p.subscriberId) })
      .from(p)
      .where(
        and(
          eq(p.projectId, input.projectId),
          eq(p.isTrial, true),
          gte(p.purchaseDate, input.from),
          lte(p.purchaseDate, input.to),
        ),
      ),
  ]);

  const w = windowRows[0] ?? {
    gross_usd: "0",
    refunds_usd: "0",
    paying_subs: "0",
    trial_conversions: "0",
  };
  const l = ltvRows[0] ?? {
    avg_usd: "0",
    median_usd: "0",
    p90_usd: "0",
    subscribers: "0",
  };

  const gross = Number(w.gross_usd);
  const refunds = Number(w.refunds_usd);
  const net = gross - refunds;
  const payingSubscribers = Number(w.paying_subs);

  const refundRate = gross > 0 ? refunds / gross : null;
  const arppu =
    payingSubscribers > 0 ? (net / payingSubscribers).toFixed(4) : null;

  const trialConversions = Number(w.trial_conversions);
  const activeSubscriberBase = Number(activeRow[0]?.c ?? 0);
  const churnedInWindow = Number(churnedRow[0]?.c ?? 0);
  const trialStarts = Number(trialStartRow[0]?.c ?? 0);

  const arpu =
    activeSubscriberBase > 0 ? (net / activeSubscriberBase).toFixed(4) : null;
  const churnDenom = activeSubscriberBase + churnedInWindow;
  const churnRate = churnDenom > 0 ? churnedInWindow / churnDenom : null;
  const trialConversionRate =
    trialStarts > 0 ? trialConversions / trialStarts : null;

  return {
    grossUsd: gross.toFixed(4),
    refundsUsd: refunds.toFixed(4),
    netUsd: net.toFixed(4),
    refundRate,
    payingSubscribers,
    arppu,
    avgLtvUsd: l.avg_usd,
    medianLtvUsd: l.median_usd,
    p90LtvUsd: l.p90_usd,
    ltvSubscribers: Number(l.subscribers),
    activeSubscriberBase,
    arpu,
    churnedInWindow,
    churnRate,
    trialStarts,
    trialConversions,
    trialConversionRate,
  };
}

// =============================================================
// Daily grain — chart-catalog `trials_started` / `churn`
// =============================================================
//
// Both `trialStarts` and `churnRate` above are Postgres facts, not
// ClickHouse ones: `raw_revenue_events` carries no `isTrial` column and
// no subscription status — those live only on `purchases`. So unlike
// `new_subs`/`reactivations` (mrr-decomposition.ts), this widening is a
// `purchases` GROUP BY day, not a ClickHouse query — there is nothing
// here to keep `FINAL` on, and no ClickHouse migration is implicated
// either way.

export interface DailyLifecycleCount {
  /** YYYY-MM-DD, UTC. */
  day: string;
  n: number;
}

export interface GetSummaryDailyInput {
  projectId: string;
  from: Date;
  to: Date;
}

/**
 * Daily grain of `trialStarts` above — the identical filter
 * (`isTrial = true`, `purchaseDate` in window), bucketed by day instead
 * of collapsed to one window total.
 *
 * NOTE: `count(DISTINCT subscriberId)` per day, summed across days, can
 * in principle exceed the window's own distinct count if the SAME
 * subscriber started a trial on two different days inside the window.
 * Real data essentially never does this (one trial per subscriber per
 * product) and this function does not special-case it.
 */
export async function getTrialStartsDaily(
  input: GetSummaryDailyInput,
): Promise<DailyLifecycleCount[]> {
  const p = drizzle.schema.purchases;
  const rows = await drizzle.db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${p.purchaseDate}), 'YYYY-MM-DD')`,
      n: countDistinct(p.subscriberId),
    })
    .from(p)
    .where(
      and(
        eq(p.projectId, input.projectId),
        eq(p.isTrial, true),
        gte(p.purchaseDate, input.from),
        lte(p.purchaseDate, input.to),
      ),
    )
    .groupBy(sql`date_trunc('day', ${p.purchaseDate})`);

  return rows.map((r) => ({ day: r.day, n: Number(r.n) }));
}

interface ChDailyConversionRow {
  day: string;
  n: string;
}

/**
 * Daily grain backing the chart-catalog `trial_to_paid` id — as a
 * COUNT, not a rate. ClickHouse (task 4), unlike `getTrialStartsDaily`/
 * `getChurnDaily` above.
 *
 * `trialConversions` in `getRevenueSummary` above (line ~76) is
 * `uniqExactIf(subscriberId, type = 'TRIAL_CONVERSION')` on
 * `raw_revenue_events` — this is that same predicate, day-grouped by
 * `eventDate`, `FINAL` retained for the same at-least-once-outbox
 * reason as every other `raw_revenue_events` reader in this file.
 *
 * WHY THIS IS A COUNT, NOT A RATE (read before "fixing" it to divide by
 * `getTrialStartsDaily`): a trial that STARTS on day D typically
 * CONVERTS on a LATER day, after the trial length elapses — so day D's
 * conversions are overwhelmingly drawn from trials that started on
 * EARLIER days, not from day D's starters. Dividing day D's conversions
 * by day D's trial STARTS would compare two disjoint, time-offset
 * cohorts and report the result as a same-day rate. This repo already
 * identified this exact failure mode for this exact event type: see
 * `charts.ts`'s `PURCHASE_NUMERATOR_EVENT_TYPE` comment, which excludes
 * TRIAL_CONVERSION from `paywall_purchase`'s same-day numerator for
 * precisely this lag reason ("a trial started from a paywall view on
 * day 1 converts on day 8, landing in day 8's numerator against day
 * 8's viewers"). It is the identical mismatch here, just with
 * `trialStarts` standing in for `viewers`.
 *
 * A sound per-day trial-to-paid RATE is derivable in principle — bucket
 * by TRIAL-START day (not conversion day), numerator = how many of that
 * day's starters (matched by subscriberId, not by day) EVER convert —
 * but that is a subscriber-level cross-store join (Postgres start-day
 * cohort ⋈ ClickHouse ever-converted set) with right-censoring for
 * cohorts too recent to have finished converting (same shape of
 * limitation as a retention curve's incomplete tail). That is real work
 * deserving its own review, not an in-file widening, so it is not built
 * here. Per the task-4 controller notes' own binding rule ("if you can
 * only get a daily numerator, ship the count and say so"), this ships
 * as `unit: "count"` in `charts.ts`'s `trial_to_paid` case — same
 * pattern as `getChurnDaily` just above.
 */
export async function getTrialConversionsDaily(
  input: GetSummaryDailyInput,
): Promise<DailyLifecycleCount[]> {
  const rows = await queryAnalytics<ChDailyConversionRow>(
    input.projectId,
    `
      SELECT
        toString(toDate(eventDate))                                     AS day,
        toString(uniqExactIf(subscriberId, type = 'TRIAL_CONVERSION'))   AS n
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
      GROUP BY day
      ORDER BY day
    `,
    { from: toDateOnly(input.from), to: toDateOnly(input.to) },
  );

  return rows.map((r) => ({ day: r.day, n: Number(r.n) }));
}

/**
 * Daily grain backing the chart-catalog `churn` id — as a COUNT, not a
 * rate.
 *
 * FIX (task-3 round 1): the window-level `churnRate` above divides
 * `churnedInWindow` by `activeSubscriberBase`, a live snapshot with no
 * date bound at all — a reasonable denominator for a SINGLE window
 * figure (that's what `RevenueKpisCard`'s tile is), but wrong to stretch
 * across a daily series: a point for 12 March would read as March's
 * churn count over TODAY's active base, not a churn rate for that day.
 * That shipped once in this file (constant-denominator `percent` daily
 * series) and was caught in review — see task-3-fixes.md. So this
 * function returns only the numerator, day-grouped, and the reader
 * reports `unit: "count"`; the window RATE stays exactly where its
 * denominator is valid — `RevenueKpisCard` — untouched by this file.
 *
 * A genuine per-day churn RATE is derivable, just heavier than this
 * task's scope: it needs a per-day active base, i.e. for each day D,
 * `count(DISTINCT subscriberId) WHERE purchaseDate <= D AND
 * (expiresDate IS NULL OR expiresDate > D)` — active-as-of-that-day,
 * not active-today. That's a per-day point-in-time query (one per
 * bucket, or a running-total reconstruction), not a single GROUP BY,
 * which is why it isn't done here.
 */
export async function getChurnDaily(
  input: GetSummaryDailyInput,
): Promise<DailyLifecycleCount[]> {
  const p = drizzle.schema.purchases;
  const rows = await drizzle.db
    .select({
      day: sql<string>`to_char(date_trunc('day', COALESCE(${p.cancellationDate}, ${p.expiresDate})), 'YYYY-MM-DD')`,
      n: countDistinct(p.subscriberId),
    })
    .from(p)
    .where(
      and(
        eq(p.projectId, input.projectId),
        inArray(p.status, ["EXPIRED", "REFUNDED", "REVOKED"]),
        or(
          and(
            isNotNull(p.cancellationDate),
            gte(p.cancellationDate, input.from),
            lte(p.cancellationDate, input.to),
          ),
          and(
            isNull(p.cancellationDate),
            isNotNull(p.expiresDate),
            gte(p.expiresDate, input.from),
            lte(p.expiresDate, input.to),
          ),
        ),
      ),
    )
    .groupBy(
      sql`date_trunc('day', COALESCE(${p.cancellationDate}, ${p.expiresDate}))`,
    );

  return rows.map((r) => ({ day: r.day, n: Number(r.n) }));
}
