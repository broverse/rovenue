import type {
  ChartChannelsResponse,
  ChartChannelsRow,
  ChartCountryCoverage,
  ChartFilterOption,
  ChartFilterOptionsResponse,
  ChartFunnelResponse,
  ChartFunnelStep,
  ChartHeatmapCell,
  ChartHeatmapResponse,
  ChartProceedsResponse,
  ChartProceedsRow,
  ChartSeriesPoint,
  ChartSeriesResponse,
} from "@rovenue/shared";
import { drizzle, type Store } from "@rovenue/db";
import {
  ClickHouseUnavailableError,
  isClickHouseConfigured,
  queryAnalytics,
} from "../../lib/clickhouse";
import { listDailyMrr, type MrrPoint } from "./mrr";
import { computeNetRevenue, computeProceedsForProject } from "./proceeds";
import { getMrrDecompositionDailyCounts } from "./mrr-decomposition";
import {
  getChurnDaily,
  getTrialConversionsDaily,
  getTrialStartsDaily,
} from "./summary";

// =============================================================
// Charts service (Phase 3.5)
// =============================================================
//
// Three pure CH queries that feed the charts page panels:
//
//   GET /charts/channels  per-store gross USD donut
//   GET /charts/funnel    INITIAL → trial → trial→paid → renewal
//   GET /charts/heatmap   day-of-week × hour event count grid
//
// All three accept an integer `windowDays` query parameter
// (default 28, max 365). The endpoints are read-only so the
// route surface is intentionally tiny — no cursors, no
// pagination.

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MAX_DAYS = 365;
/** ARR is a run-rate projection of the current month's net MRR. */
const MONTHS_PER_YEAR = 12;

interface Window {
  from: Date;
  to: Date;
  days: number;
}

function buildWindow(windowDays: number): Window {
  const days = Math.min(Math.max(windowDays, 1), WINDOW_MAX_DAYS);
  const to = new Date();
  to.setUTCHours(23, 59, 59, 999);
  const from = new Date(to.getTime() - (days - 1) * DAY_MS);
  from.setUTCHours(0, 0, 0, 0);
  return { from, to, days };
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function assertClickHouseReady(): void {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }
}

// =============================================================
// Channels — donut data
// =============================================================

interface ChChannelRow {
  store: string;
  gross_usd: string;
  event_count: string;
}

export async function readChannels(
  projectId: string,
  windowDays: number,
): Promise<ChartChannelsResponse> {
  assertClickHouseReady();
  const w = buildWindow(windowDays);
  const rows = await queryAnalytics<ChChannelRow>(
    projectId,
    `
      SELECT
        store,
        toString(sum(amountUsd))   AS gross_usd,
        toString(count())          AS event_count
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
        AND type NOT IN ('REFUND','CHARGEBACK')
      GROUP BY store
      ORDER BY sum(amountUsd) DESC
    `,
    { from: toDateOnly(w.from), to: toDateOnly(w.to) },
  );

  const total = rows.reduce((a, r) => a + Number(r.gross_usd), 0);
  const mapped: ChartChannelsRow[] = rows.map((r) => {
    const g = Number(r.gross_usd);
    return {
      store: r.store,
      grossUsd: r.gross_usd,
      pct: total > 0 ? Math.round((g / total) * 1000) / 10 : 0,
      eventCount: Number(r.event_count),
    };
  });
  return {
    windowDays: w.days,
    totalUsd: total.toFixed(4),
    rows: mapped,
  };
}

// =============================================================
// Estimated proceeds — per-store gross/refunds from ClickHouse,
// composed with the configured commission rate (Postgres)
// =============================================================
//
// Design (spec §4.3, proceeds.ts's header comment): query time only,
// refunds net first then the rate applies, and a project with no
// configured rate for a store gets `null` — never a silent 0%.
//
// This is deliberately a PER-STORE breakdown, not a single blended
// figure: a project can have a rate for APP_STORE and none for
// PLAY_STORE, and summing them into one number would hide which part
// is a real estimate and which part is undefined. So this is NOT
// dispatched through `readChartSeries` (whose `ChartSeriesResponse` is
// one line of daily points), and for the same reason it is NOT a
// chart-catalog id either: a catalog entry is selectable and renders the
// series panel, so an id that dispatcher cannot serve dead-ends on "not
// wired to a data source". It is served by its own route/reader instead,
// the same way `readChannels` already is despite not being a catalog id
// at all, and surfaced by the always-visible `ProceedsCard`.
//
// CHARGEBACK is netted out of gross alongside REFUND (both return the
// money to the customer), matching `readChannels`'s existing gross
// exclusion list — this module does not introduce a new convention.

interface ChProceedsRow {
  store: string;
  gross_usd: string;
  refunds_usd: string;
}

export async function readProceeds(
  projectId: string,
  windowDays: number,
): Promise<ChartProceedsResponse> {
  assertClickHouseReady();
  const w = buildWindow(windowDays);
  const rows = await queryAnalytics<ChProceedsRow>(
    projectId,
    `
      SELECT
        store,
        toString(sumIf(amountUsd, type NOT IN ('REFUND','CHARGEBACK')))  AS gross_usd,
        toString(sumIf(amountUsd, type IN ('REFUND','CHARGEBACK')))      AS refunds_usd
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
      GROUP BY store
      ORDER BY store
    `,
    { from: toDateOnly(w.from), to: toDateOnly(w.to) },
  );

  const mapped: ChartProceedsRow[] = await Promise.all(
    rows.map(async (r): Promise<ChartProceedsRow> => {
      const gross = Number(r.gross_usd);
      const refunds = Number(r.refunds_usd);
      const estimate = await computeProceedsForProject(drizzle.db, {
        projectId,
        store: r.store as Store,
        gross,
        refunds,
      });
      return {
        store: r.store,
        grossUsd: r.gross_usd,
        refundsUsd: r.refunds_usd,
        netUsd: computeNetRevenue(gross, refunds).toFixed(4),
        rate: estimate.rate,
        proceedsUsd:
          estimate.proceeds === null ? null : estimate.proceeds.toFixed(4),
      };
    }),
  );

  return { windowDays: w.days, rows: mapped };
}

// =============================================================
// Funnel — INITIAL → TRIAL → TRIAL_CONVERSION → RENEWAL
// =============================================================
//
// The funnel is reported as four steps:
//
//   purchase       INITIAL count (one entry per new subscription)
//   trial          subscribers who entered TRIAL_CONVERSION-eligible
//                  state (count of TRIAL events isn't tracked
//                  separately; we use distinct subscribers from
//                  TRIAL_CONVERSION as a lower-bound proxy)
//   trial_to_paid  TRIAL_CONVERSION count
//   renewal        RENEWAL count
//
// Each step's `pct` is share of the first step (purchase). When
// the first step is zero we report zeros across the board so the
// chart still renders empty bars instead of NaN.

interface ChFunnelRow {
  initial: string;
  trial_converted: string;
  renewal: string;
  trial_unique_subs: string;
}

export async function readFunnel(
  projectId: string,
  windowDays: number,
): Promise<ChartFunnelResponse> {
  assertClickHouseReady();
  const w = buildWindow(windowDays);
  const rows = await queryAnalytics<ChFunnelRow>(
    projectId,
    `
      SELECT
        toString(countIf(type = 'INITIAL'))                                       AS initial,
        toString(countIf(type = 'TRIAL_CONVERSION'))                              AS trial_converted,
        toString(countIf(type = 'RENEWAL'))                                       AS renewal,
        toString(uniqExactIf(subscriberId, type = 'TRIAL_CONVERSION'))            AS trial_unique_subs
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
    `,
    { from: toDateOnly(w.from), to: toDateOnly(w.to) },
  );

  const r = rows[0];
  const initial = Number(r?.initial ?? "0");
  const trialUniqueSubs = Number(r?.trial_unique_subs ?? "0");
  const trialConverted = Number(r?.trial_converted ?? "0");
  const renewal = Number(r?.renewal ?? "0");

  // First step is INITIAL — every funnel %% is relative to that.
  const denom = initial > 0 ? initial : 1;
  const pct = (n: number): number =>
    initial > 0 ? Math.round((n / denom) * 1000) / 10 : 0;

  const steps: ChartFunnelStep[] = [
    { key: "purchase", count: initial, pct: initial > 0 ? 100 : 0 },
    { key: "trial", count: trialUniqueSubs, pct: pct(trialUniqueSubs) },
    { key: "trial_to_paid", count: trialConverted, pct: pct(trialConverted) },
    { key: "renewal", count: renewal, pct: pct(renewal) },
  ];

  return { windowDays: w.days, steps };
}

// =============================================================
// Heatmap — DOW × hour event count
// =============================================================

interface ChHeatmapRow {
  dow: string;
  hour: string;
  c: string;
}

export async function readHeatmap(
  projectId: string,
  windowDays: number,
): Promise<ChartHeatmapResponse> {
  assertClickHouseReady();
  const w = buildWindow(windowDays);
  const rows = await queryAnalytics<ChHeatmapRow>(
    projectId,
    `
      SELECT
        toString(toDayOfWeek(eventDate))   AS dow,
        toString(toHour(eventDate))        AS hour,
        toString(count())                  AS c
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
      GROUP BY toDayOfWeek(eventDate), toHour(eventDate)
      ORDER BY dow ASC, hour ASC
    `,
    { from: toDateOnly(w.from), to: toDateOnly(w.to) },
  );

  // ClickHouse `toDayOfWeek` returns 1..7 with Monday=1. Convert
  // to the wire convention (0=Sunday … 6=Saturday) so the UI
  // doesn't have to translate.
  const cells: ChartHeatmapCell[] = rows.map((r) => {
    const chDow = Number(r.dow);
    const dow = chDow === 7 ? 0 : chDow;
    return {
      dow,
      hour: Number(r.hour),
      count: Number(r.c),
    };
  });

  return { windowDays: w.days, cells };
}

// =============================================================
// Filter options — distinct values from the revenue stream
// =============================================================
//
// Powers the right-rail Filters card on /charts. We surface the
// distinct values that are actually present in the project's CH
// data so users aren't presented with options that can't match
// anything.
//
// `productGroupId` was removed entirely (2026-09-01): it never
// existed on `raw_revenue_events` — querying it always raised CH
// error 47 (UNKNOWN_IDENTIFIER) — and had no consumer anywhere in
// the dashboard. Do not reintroduce it without a real column.
//
// `country` previously referenced a non-existent column
// (`subscriberCountry`). It is real now (migration 0023): sourced from
// the store's own per-transaction country — e.g. Apple's `storefront` —
// never the subscriber's last-known SDK-reported country, which is a
// different fact. See
// docs/superpowers/specs/2026-09-01-analytics-integrity-and-proceeds-design.md
// §4.2. Do not reintroduce a subscriber-attribute fallback for this.

interface ChDistinctRow {
  value: string;
  c: string;
}

/**
 * Row cap on a dropdown feed. A filter chip list has to end somewhere —
 * the top values by count are the ones a user picks from.
 *
 * This cap is a DISPLAY concern and must never leak into a statistic:
 * `countryCoverage` below is counted separately, uncapped, precisely
 * because summing a truncated list understates coverage for any project
 * selling in more than this many storefronts.
 */
const DISTINCT_OPTION_LIMIT = 50;

async function distinctDimension(
  projectId: string,
  expr: string,
  from: string,
  to: string,
  limit = DISTINCT_OPTION_LIMIT,
): Promise<ChartFilterOption[]> {
  const rows = await queryAnalytics<ChDistinctRow>(
    projectId,
    `
      SELECT
        ${expr}              AS value,
        toString(count())    AS c
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
        AND ${expr} != ''
      GROUP BY value
      ORDER BY count() DESC
      LIMIT {limit:UInt32}
    `,
    { from, to, limit },
  );
  return rows.map((r) => ({
    value: r.value,
    label: r.value,
    count: Number(r.c),
  }));
}

interface ChCountryCoverageRow {
  known: string;
  total: string;
}

/**
 * Country coverage for the window: how many revenue events carry a
 * store-supplied country, out of how many there are.
 *
 * Its own query on purpose. The obvious shortcut — sum `country[].count`
 * and divide by the sum of `platform[].count` — reads the DROPDOWN feed,
 * which stops at `DISTINCT_OPTION_LIMIT` rows. A project with more
 * storefronts than that would report less than full coverage while having
 * full coverage, i.e. the honesty feature would itself misreport. Two
 * scalars over the whole window cannot truncate.
 */
async function readCountryCoverage(
  projectId: string,
  from: string,
  to: string,
): Promise<ChartCountryCoverage> {
  const rows = await queryAnalytics<ChCountryCoverageRow>(
    projectId,
    `
      SELECT
        toString(countIf(country != '')) AS known,
        toString(count())                AS total
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
    `,
    { from, to },
  );
  // An aggregate with no GROUP BY always returns exactly one row, but a
  // ClickHouse client that returns none must not throw here: zero events
  // is a legitimate empty window, which the UI renders as "no revenue".
  const row = rows[0];
  return {
    eventsWithCountry: Number(row?.known ?? 0),
    totalEvents: Number(row?.total ?? 0),
  };
}

export async function readFilterOptions(
  projectId: string,
  windowDays: number,
): Promise<ChartFilterOptionsResponse> {
  assertClickHouseReady();
  const w = buildWindow(windowDays);
  const from = toDateOnly(w.from);
  const to = toDateOnly(w.to);

  const platform = await distinctDimension(projectId, "store", from, to);
  const country = await distinctDimension(projectId, "country", from, to);
  const countryCoverage = await readCountryCoverage(projectId, from, to);

  return {
    windowDays: w.days,
    platform,
    countryCoverage,
    country,
  };
}

export const __chartsConstants = {
  WINDOW_DEFAULT_DAYS: 28,
  WINDOW_MAX_DAYS,
};

// =============================================================
// Generic chart series — shared rate arithmetic
// =============================================================

/** One day's count as ClickHouse returns it: counts arrive stringified. */
export interface DailyCountRow {
  day: string; // YYYY-MM-DD
  n: string;
}

/**
 * Rounding scale for percentages: multiply, round, divide back.
 * 10 gives one decimal place.
 */
const PCT_ROUNDING_SCALE = 10;

/**
 * Align two daily aggregates into one point per day across the
 * window and divide them.
 *
 * A zero denominator yields `value: null`, never 0 — a day with no
 * traffic has an UNDEFINED rate, and drawing it as 0% would read as a
 * collapse rather than an absence. The inputs are reported either way
 * so a caller can show "3 of 120".
 *
 * Extracted from the readers deliberately: this repo cannot run
 * ClickHouse in tests, so keeping the arithmetic out of SQL is what
 * makes it provable.
 */
export function buildRatePoints(
  numerator: DailyCountRow[],
  denominator: DailyCountRow[],
  from: Date,
  to: Date,
): ChartSeriesPoint[] {
  const num = new Map(numerator.map((r) => [r.day, Number(r.n)]));
  const den = new Map(denominator.map((r) => [r.day, Number(r.n)]));

  const points: ChartSeriesPoint[] = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() <= end.getTime()) {
    const key = toDateOnly(cursor);
    const n = num.get(key) ?? 0;
    const d = den.get(key) ?? 0;
    points.push({
      bucket: new Date(cursor).toISOString(),
      value: d > 0 ? Math.round((n / d) * 100 * PCT_ROUNDING_SCALE) / PCT_ROUNDING_SCALE : null,
      numerator: n,
      denominator: d,
    });
    cursor.setTime(cursor.getTime() + DAY_MS);
  }

  return points;
}

/**
 * Align `listDailyMrr`'s sparse per-day rows (`v_mrr_daily` is a plain
 * `GROUP BY day` — a day with zero revenue events simply has no row)
 * onto every day in the window, then apply `extract` to each day's
 * row (or `undefined` when the day is absent).
 *
 * A day absent from ClickHouse is a REAL, measured zero — "no revenue
 * events happened" is not the same kind of gap as a ratio's zero
 * denominator — so `extract` gets to decide per-metric what an absent
 * day means (0 for an additive money total, `null` for a ratio like
 * ARPU whose denominator is genuinely undefined that day).
 *
 * Extracted from the readers deliberately, same reasoning as
 * `buildRatePoints`: this repo cannot run ClickHouse in tests, so
 * keeping the arithmetic out of SQL is what makes it provable.
 */
export function buildMrrSeriesPoints(
  rows: MrrPoint[],
  from: Date,
  to: Date,
  extract: (row: MrrPoint | undefined) => number | null,
): ChartSeriesPoint[] {
  const byDay = new Map(rows.map((r) => [toDateOnly(r.bucket), r]));

  const points: ChartSeriesPoint[] = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() <= end.getTime()) {
    const row = byDay.get(toDateOnly(cursor));
    points.push({
      bucket: new Date(cursor).toISOString(),
      value: extract(row),
    });
    cursor.setTime(cursor.getTime() + DAY_MS);
  }

  return points;
}

/**
 * One point per day from a plain daily COUNT series — `new_subs`,
 * `reactivations`, `trials_started`. There is no zero-denominator case
 * here (it isn't a ratio), so an absent day is a real, measured zero
 * ("nothing happened"), not an undefined value — unlike
 * `buildRatePoints`'s `null`.
 *
 * Extracted from the readers for the same reason as `buildRatePoints` /
 * `buildMrrSeriesPoints`: this repo cannot run ClickHouse in tests, so
 * keeping the arithmetic out of SQL is what makes it provable.
 */
export function buildCountSeriesPoints(
  rows: ReadonlyArray<{ day: string; n: number }>,
  from: Date,
  to: Date,
): ChartSeriesPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r.n]));

  const points: ChartSeriesPoint[] = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() <= end.getTime()) {
    const key = toDateOnly(cursor);
    points.push({
      bucket: new Date(cursor).toISOString(),
      value: byDay.get(key) ?? 0,
    });
    cursor.setTime(cursor.getTime() + DAY_MS);
  }

  return points;
}

// =============================================================
// Generic chart series — paywall reach/conversion and revenue
// =============================================================
//
// Eleven of the sixteen catalog charts are wired (paywall_view_rate,
// paywall_purchase, mrr, arr, gross_vs_net, arpu — the last four
// delegate to `listDailyMrr`, see buildMrrSeriesPoints below — plus
// new_subs, reactivations, trials_started, churn — task-3's
// subscription-lifecycle group, all four daily COUNTS, see
// buildCountSeriesPoints above — plus trial_to_paid, task-4, also a
// daily COUNT, see getTrialConversionsDaily's doc comment in
// summary.ts for why a rate isn't shipped). Every other id
// answers `supported: false` so the dashboard renders an empty
// state rather than another chart's data. `readChartSeries`'s
// `switch` is the ONLY dispatch mechanism (no separate id allow-list)
// so a chart id can never be "in the supported set" yet fall through
// to another chart's reader — the two can't disagree if there's only
// one of them. Its `default` case must return with ZERO ClickHouse
// queries issued, `paywall_purchase`'s data leaking out under
// `churn`'s name (or any other id's) is exactly the bug this
// dispatch exists to prevent.
//
// TWO IDS DELIBERATELY STAY UNWIRED (task 4, controller ruling — see
// task-4-report.md for the full reasoning):
//
//   - `retention_curve`: `computeRetention` (`services/cohorts.ts`)
//     produces a cohort × PERIOD-SINCE-JOIN matrix, not a per-CALENDAR-
//     DAY series. `ChartSeriesPoint.bucket` is documented as a calendar
//     date; forcing periods-since-cohort-start onto it would fabricate
//     dates that don't mean what the field says they mean. `/cohorts`
//     already renders the real matrix as a heatmap — that is this
//     metric's surface, not this dispatcher. The catalog's declared
//     `chartType: "line"` for this id does not describe the data (see
//     chart-catalog.ts's comment at the entry); that mismatch is
//     recorded for product to resolve, not silently "fixed" here.
//   - `ltv`: every owning service was checked for a day column.
//     `getLtvDistribution` (ltv.ts) and `getRevenueSummary.avgLtvUsd`
//     both read `v_revenue_lifetime_subscriber`, a view with no
//     `eventDate`/day column at all (`GROUP BY projectId, subscriberId`
//     — see its migration, 0013/0014) — a lifetime-to-date snapshot per
//     subscriber, not a dated event log, so there is no "day" to widen
//     by. `getLtvPrediction`/`computeLtvPrediction` (ltv-prediction.ts /
//     ltv-extrapolation.ts) are cohort-MONTH based (sparse, one point
//     per acquisition month, not one per calendar day) and otherwise
//     return a single blended scalar — also not a daily series. No
//     in-file widening produces a daily average LTV from any of them.

/**
 * Revenue event type counted in the `paywall_purchase` numerator.
 *
 * This chart is a same-day RATE (purchasers ÷ *that day's* paywall
 * viewers), which is a different shape from `placement_metrics` in
 * analytics-router.ts — that endpoint sums INITIAL + RENEWAL +
 * TRIAL_CONVERSION + REACTIVATION as a placement's LIFETIME total,
 * where counting renewals is correct. Copying that list here would
 * not be: only 'INITIAL' belongs in a same-day numerator.
 *
 *   - RENEWAL / REACTIVATION recur long after the paywall view that
 *     earned them. On Stripe, `presentedContext` is copied onto the
 *     subscription and persists for its life (stripe-webhook.ts sets
 *     it from `purchase.presentedContext` at creation), so a
 *     subscriber's month-2+ renewal still carries the ORIGINAL
 *     non-empty paywallId and lands in TODAY's numerator against
 *     TODAY's viewers — a different, unrelated set of people. 200
 *     renewals against 20 viewers renders 1000% on a `unit: "percent"`
 *     panel.
 *   - TRIAL_CONVERSION has the identical lag: a trial started from a
 *     paywall view on day 1 converts on day 8, landing in day 8's
 *     numerator against day 8's viewers. This is a deliberate
 *     deviation from including TRIAL_CONVERSION — the lag argument
 *     applies to it exactly as it does to RENEWAL/REACTIVATION. A
 *     trial *start* at the paywall doesn't need separate counting:
 *     it is already an INITIAL event (carrying `isTrial`), distinct
 *     from the later TRIAL_CONVERSION.
 */
const PURCHASE_NUMERATOR_EVENT_TYPE = "'INITIAL'";

/** Daily unique subscribers who saw any paywall in this project. */
async function readPaywallViewers(
  projectId: string,
  from: string,
  to: string,
): Promise<DailyCountRow[]> {
  // NOTE: select the bare `day` column, not `toString(day) AS day` —
  // re-aliasing it to its own name trips ClickHouse's GROUP BY/ORDER BY
  // alias substitution against the WHERE clause's Date-typed comparison
  // (NO_COMMON_TYPE: String vs Date), confirmed by hand against dev
  // ClickHouse. JSONEachRow already serializes a Date column as a
  // quoted string ("2026-07-22"), matching DailyCountRow.day: string,
  // so the cast was redundant anyway.
  return queryAnalytics<DailyCountRow>(
    projectId,
    `
      SELECT
        day,
        toString(uniqMerge(subscribersHll))    AS n
      FROM rovenue.mv_paywall_daily_target
      WHERE projectId = {projectId:String}
        AND day >= {from:Date}
        AND day <= {to:Date}
      GROUP BY day
      ORDER BY day
    `,
    { projectId, from, to },
  );
}

/**
 * Daily unique subscribers with a finalised SDK session — the
 * `paywall_view_rate` denominator.
 *
 * CAVEAT: `v_sdk_sessions_daily` only counts sessions that reached a
 * `background`/`close` event (0016_sdk_sessions_idempotent.sql); a
 * subscriber who views a paywall and force-kills the app lands in
 * the numerator (paywall view fired) but never finalises a session,
 * so is absent from this denominator. That can push the rate above
 * 100% on days with a lot of force-kills — that is this known gap,
 * not a bug in the arithmetic. Do not "fix" it by loosening the
 * source view; see 0016's migration comment for why it's FINAL-only.
 *
 * CAVEAT (partial day): `to` is always the current, in-progress UTC
 * day when the caller asks for "up to today" (which every chart
 * window does). A paywall view fires immediately, so it lands in
 * today's numerator right away; a session only finalises this
 * denominator once it backgrounds/closes, which for a still-open
 * session on today's date hasn't happened yet. So today's bucket of
 * `paywall_view_rate` is biased high for the same session-lag reason
 * as the force-kill gap above — it's a live, undercounted denominator
 * against a live numerator, not a data-quality bug. It self-corrects
 * once the day is no longer "today". Do not drop the partial day from
 * the window to "fix" it — see the same guidance as above.
 */
async function readActiveSubscribers(
  projectId: string,
  from: string,
  to: string,
): Promise<DailyCountRow[]> {
  // Select the bare `day` column (not `toString(day) AS day`) — see
  // readPaywallViewers for why the re-alias trips ClickHouse's
  // GROUP BY/ORDER BY substitution against the WHERE clause.
  //
  // NOTE: `sdk_sessions_daily_tbl` (0010) was dropped by migration
  // 0016_sdk_sessions_idempotent.sql — the SummingMergeTree rollup
  // double-counted replayed outbox events, same failure mode as the
  // revenue rollups (see 0012). `v_sdk_sessions_daily` is the
  // query-time-deduped replacement (FINAL over raw_sdk_session_events)
  // and is what every current caller reads from.
  return queryAnalytics<DailyCountRow>(
    projectId,
    `
      SELECT
        day,
        toString(uniq(subscriberId))   AS n
      FROM rovenue.v_sdk_sessions_daily
      WHERE projectId = {projectId:String}
        AND day >= {from:Date}
        AND day <= {to:Date}
      GROUP BY day
      ORDER BY day
    `,
    { projectId, from, to },
  );
}

/** Daily unique paywall-attributed purchasers — `paywall_purchase`'s numerator. */
async function readPaywallPurchasers(
  projectId: string,
  from: string,
  to: string,
): Promise<DailyCountRow[]> {
  // Precise attribution, mirroring analytics-router's placement_metrics:
  // raw_revenue_events carries the purchase's originating paywallId
  // (migration 0019), so no viewer-overlap heuristic is needed.
  //
  // KNOWN HORIZON: rows written before 0019 carry paywallId = '' and
  // cannot match, so this chart under-reports for dates before that
  // migration was deployed. That is the data, not a bug — do not
  // "fix" it by dropping the filter, which would attribute every
  // purchase to a paywall.
  return queryAnalytics<DailyCountRow>(
    projectId,
    `
      SELECT
        toString(toDate(eventDate))       AS day,
        toString(uniq(subscriberId))      AS n
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
        AND paywallId != ''
        AND type = ${PURCHASE_NUMERATOR_EVENT_TYPE}
      GROUP BY day
      ORDER BY day
    `,
    { projectId, from, to },
  );
}

export async function readChartSeries(
  projectId: string,
  chartId: string,
  windowDays: number,
): Promise<ChartSeriesResponse> {
  const w = buildWindow(windowDays);
  const base = {
    chartId,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
  };

  switch (chartId) {
    case "paywall_view_rate": {
      // Reach: what share of the day's active subscribers saw a paywall.
      assertClickHouseReady();
      const from = toDateOnly(w.from);
      const to = toDateOnly(w.to);
      // Independent queries — run concurrently rather than serially
      // awaiting one after the other.
      const [viewers, actives] = await Promise.all([
        readPaywallViewers(projectId, from, to),
        readActiveSubscribers(projectId, from, to),
      ]);
      return {
        ...base,
        unit: "percent",
        points: buildRatePoints(viewers, actives, w.from, w.to),
        supported: true,
      };
    }

    case "paywall_purchase": {
      // Conversion: what share of paywall viewers bought.
      assertClickHouseReady();
      const from = toDateOnly(w.from);
      const to = toDateOnly(w.to);
      // Independent queries — run concurrently rather than serially
      // awaiting one after the other.
      const [purchasers, viewers] = await Promise.all([
        readPaywallPurchasers(projectId, from, to),
        readPaywallViewers(projectId, from, to),
      ]);
      return {
        ...base,
        unit: "percent",
        points: buildRatePoints(purchasers, viewers, w.from, w.to),
        supported: true,
      };
    }

    case "mrr": {
      // Net MRR, per day — the same figure the bespoke MrrChartPanel
      // rolls up to months; this generic panel plots it daily instead.
      assertClickHouseReady();
      const rows = await listDailyMrr({ projectId, from: w.from, to: w.to });
      return {
        ...base,
        unit: "money",
        points: buildMrrSeriesPoints(rows, w.from, w.to, (row) =>
          row ? Number(row.netUsd) : 0,
        ),
        supported: true,
      };
    }

    case "arr": {
      // Run-rate projection: net MRR annualised. Derived, not a
      // separately-tracked figure — see MONTHS_PER_YEAR.
      assertClickHouseReady();
      const rows = await listDailyMrr({ projectId, from: w.from, to: w.to });
      return {
        ...base,
        unit: "money",
        points: buildMrrSeriesPoints(rows, w.from, w.to, (row) =>
          row ? Number(row.netUsd) * MONTHS_PER_YEAR : 0,
        ),
        supported: true,
      };
    }

    case "gross_vs_net": {
      // DECISION (task-2 controller notes, REVISED in fix round 1):
      // this id names two quantities but ChartSeriesPoint carries
      // one. We plot the RATIO — net ÷ gross, the share of gross
      // revenue that survives refunds/chargebacks — as a `percent`
      // series, NOT the difference.
      //
      // A prior version of this reader plotted the DIFFERENCE
      // (gross − net, i.e. refundsUsd) as a money series, reasoning
      // that MrrChartPanel's own `refunds` bucket
      // (mrr-chart-panel.tsx's `rollupToMonths`) already computes
      // that figure. That precedent cuts the other way on closer
      // reading: `rollupToMonths` rolls up all THREE of gross, net
      // AND refunds as one breakdown, so shipping just the refunds
      // slice alone under a label naming the other two ("Gross vs
      // net revenue") is a mismatch, and it made this chart largely
      // redundant with a panel that already draws that exact series.
      // The ratio is the one number that actually expresses "gross
      // vs net" as a comparison, and it doesn't duplicate anything
      // MrrChartPanel already shows.
      //
      // A day with zero gross has an UNDEFINED ratio — null, not 0,
      // per ChartSeriesPoint's documented convention (distinct from
      // "measured, and it was zero"). Percentage scale/rounding
      // matches buildRatePoints' convention (0-100, one decimal via
      // PCT_ROUNDING_SCALE) — see series-chart-panel.tsx:162, which
      // formats every `percent` series the same way.
      assertClickHouseReady();
      const rows = await listDailyMrr({ projectId, from: w.from, to: w.to });
      return {
        ...base,
        unit: "percent",
        points: buildMrrSeriesPoints(rows, w.from, w.to, (row) => {
          if (!row) return null;
          const gross = Number(row.grossUsd);
          if (gross <= 0) return null;
          return (
            Math.round((Number(row.netUsd) / gross) * 100 * PCT_ROUNDING_SCALE) /
            PCT_ROUNDING_SCALE
          );
        }),
        supported: true,
      };
    }

    case "arpu": {
      // Net revenue ÷ active subscribers, per day. Both columns are
      // already on MrrPoint; a day with zero active subscribers has
      // an UNDEFINED average (not a $0 one), so it's null, mirroring
      // buildRatePoints' zero-denominator handling.
      assertClickHouseReady();
      const rows = await listDailyMrr({ projectId, from: w.from, to: w.to });
      return {
        ...base,
        unit: "money",
        points: buildMrrSeriesPoints(rows, w.from, w.to, (row) =>
          row && row.activeSubscribers > 0
            ? Number(row.netUsd) / row.activeSubscribers
            : null,
        ),
        supported: true,
      };
    }

    // =============================================================
    // Subscription-lifecycle group (task-3): new_subs, reactivations,
    // trials_started, churn.
    // =============================================================
    //
    // new_subs/reactivations are `countIf` siblings of
    // mrr-decomposition's existing `sumIf` buckets, at a daily grain —
    // ClickHouse, FINAL retained (see mrr-decomposition.ts). churn and
    // trials_started name the same quantities as `getRevenueSummary`'s
    // `churnRate`/`trialStarts` (churn also renders on
    // `RevenueKpisCard` as "Churn rate") — both are Postgres facts
    // (subscription status/trial flag live on `purchases`, not on
    // `raw_revenue_events`), so those two readers issue no ClickHouse
    // query at all; see summary.ts for the daily widening.

    case "new_subs": {
      assertClickHouseReady();
      const { newSubs } = await getMrrDecompositionDailyCounts({
        projectId,
        from: w.from,
        to: w.to,
      });
      return {
        ...base,
        unit: "count",
        points: buildCountSeriesPoints(newSubs, w.from, w.to),
        supported: true,
      };
    }

    case "reactivations": {
      assertClickHouseReady();
      const { reactivations } = await getMrrDecompositionDailyCounts({
        projectId,
        from: w.from,
        to: w.to,
      });
      return {
        ...base,
        unit: "count",
        points: buildCountSeriesPoints(reactivations, w.from, w.to),
        supported: true,
      };
    }

    case "trials_started": {
      const rows = await getTrialStartsDaily({
        projectId,
        from: w.from,
        to: w.to,
      });
      return {
        ...base,
        unit: "count",
        points: buildCountSeriesPoints(rows, w.from, w.to),
        supported: true,
      };
    }

    case "churn": {
      // FIX (task-3 round 1): this used to be a `percent` series dividing
      // each day's churn count by a CONSTANT — the project's present-day
      // active-subscriber snapshot, `getRevenueSummary`'s
      // `activeSubscriberBase` — applied to every day in the window. That
      // reads as a rate but isn't one for any day except roughly the
      // last: a point for 12 March was March's churn count over TODAY's
      // active base. Fixed to a daily COUNT (distinct subscribers who
      // churned that day) — see getChurnDaily's doc comment in
      // summary.ts for what a real per-day rate would need instead. The
      // window RATE `RevenueKpisCard` shows is untouched by this fix;
      // its denominator (a live snapshot) is valid for a single window,
      // just not for 180 daily points.
      const churnedByDay = await getChurnDaily({
        projectId,
        from: w.from,
        to: w.to,
      });
      return {
        ...base,
        unit: "count",
        points: buildCountSeriesPoints(churnedByDay, w.from, w.to),
        supported: true,
      };
    }

    case "trial_to_paid": {
      // Task 4. See getTrialConversionsDaily's doc comment in
      // summary.ts: this is a daily COUNT of TRIAL_CONVERSION events,
      // not a rate. The obvious-looking alternative — divide by
      // getTrialStartsDaily for the same day — would divide by the
      // WRONG day's denominator (trials converting today mostly
      // started on an earlier day), the identical lag mismatch this
      // file's own PURCHASE_NUMERATOR_EVENT_TYPE comment already rules
      // out for TRIAL_CONVERSION. ClickHouse, FINAL retained.
      assertClickHouseReady();
      const rows = await getTrialConversionsDaily({
        projectId,
        from: w.from,
        to: w.to,
      });
      return {
        ...base,
        unit: "count",
        points: buildCountSeriesPoints(rows, w.from, w.to),
        supported: true,
      };
    }

    default:
      // Not an error: most of the catalog simply has no reader yet.
      // No `assertClickHouseReady()` and no query above this line —
      // an unsupported id must cost zero ClickHouse round-trips.
      return { ...base, unit: "count", points: [], supported: false };
  }
}
