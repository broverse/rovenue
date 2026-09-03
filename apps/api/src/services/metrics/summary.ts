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

export interface ChurnDaily {
  /**
   * Live snapshot — exactly `activeSubscriberBase` above, NOT bounded by
   * `from`/`to` (see that field's query: no date filter at all). The
   * window-level `churnRate` above divides by this same unbounded
   * snapshot, so the daily series holds it constant across every day
   * too and only moves the numerator; see charts.ts's `churn` case for
   * why that's the faithful reading of the tile's own definition rather
   * than a shortcut.
   */
  activeSubscriberBase: number;
  /** Daily grain of `churnedInWindow` above — same status set
   *  (`EXPIRED`/`REFUNDED`/`REVOKED`), same
   *  cancellationDate-else-expiresDate bucketing. */
  churnedByDay: DailyLifecycleCount[];
}

/**
 * Daily grain backing the chart-catalog `churn` id. Matches
 * `RevenueKpisCard`'s "Churn rate" tile (revenue-kpis-card.tsx renders
 * `data.churnRate` via `fmtPct`, i.e. a 0-1 fraction multiplied by 100
 * for display) — this is the same fraction-shaped quantity, just
 * bucketed by day; charts.ts's `percent` unit convention (0-100, see
 * `buildRatePoints`) applies the ×100 at the series layer instead.
 */
export async function getChurnDaily(
  input: GetSummaryDailyInput,
): Promise<ChurnDaily> {
  const p = drizzle.schema.purchases;
  const [activeRow, churnedRows] = await Promise.all([
    drizzle.db
      .select({ c: countDistinct(p.subscriberId) })
      .from(p)
      .where(and(eq(p.projectId, input.projectId), eq(p.status, "ACTIVE"))),
    drizzle.db
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
      ),
  ]);

  return {
    activeSubscriberBase: Number(activeRow[0]?.c ?? 0),
    churnedByDay: churnedRows.map((r) => ({ day: r.day, n: Number(r.n) })),
  };
}
