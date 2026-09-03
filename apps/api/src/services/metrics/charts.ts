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
import {
  catalogCohortRule,
  catalogCohortShape,
  computeCohortLtvCurve,
  computeRetention,
} from "../cohorts";
import { getCreditBurnDaily, getCreditLiabilityDaily } from "./credits";
import { getInstallsDaily } from "./installs";
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

/**
 * One point per day of net revenue ÷ installs — the `rev_per_install`
 * arithmetic, kept here beside `buildRatePoints` for the same reason:
 * this repo cannot run ClickHouse in tests, so arithmetic that lives in
 * TypeScript is arithmetic that can be proven.
 *
 * Zero installs is an UNDEFINED average, not a $0 one, so the day is
 * `null` — matching `arpu` and `buildRatePoints`. Zero revenue on a day
 * that HAD installs is a measured 0. Both inputs are reported so the
 * panel can show "$120 ÷ 4 installs".
 */
export function buildPerInstallPoints(
  mrrRows: MrrPoint[],
  installRows: ReadonlyArray<{ day: string; n: number }>,
  from: Date,
  to: Date,
): ChartSeriesPoint[] {
  const netByDay = new Map(
    mrrRows.map((r) => [toDateOnly(r.bucket), Number(r.netUsd)]),
  );
  const installsByDay = new Map(installRows.map((r) => [r.day, r.n]));

  const points: ChartSeriesPoint[] = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() <= end.getTime()) {
    const key = toDateOnly(cursor);
    const net = netByDay.get(key) ?? 0;
    const installs = installsByDay.get(key) ?? 0;
    points.push({
      bucket: new Date(cursor).toISOString(),
      value: installs > 0 ? net / installs : null,
      numerator: net,
      denominator: installs,
    });
    cursor.setTime(cursor.getTime() + DAY_MS);
  }

  return points;
}

// =============================================================
// Generic chart series — paywall reach/conversion and revenue
// =============================================================
//
// ALL SIXTEEN catalog ids have a reader (2026-09-04;
// charts.catalog-coverage.test.ts fails by name if a seventeenth ever
// ships without one). `readChartSeries`'s `switch` is the ONLY dispatch
// mechanism — no separate id allow-list — so an id can never be "in the
// supported set" yet fall through to another chart's reader; the two
// cannot disagree if there is only one of them. The `default` case must
// return with ZERO ClickHouse queries issued: `paywall_purchase`'s data
// leaking out under `churn`'s name is exactly the bug this dispatch
// exists to prevent. It still answers `supported: false`, for an id the
// dispatcher does not know — a custom chart, or a typo.
//
// Every case delegates to the service that OWNS the concept; this file
// contains no SQL of its own beyond the four bespoke panel readers
// above. Where a daily grain did not exist it was added inside the
// owning service, never here.
//
// THE FOUR THAT TOOK LONGEST, and what changed to make each possible —
// each had been ruled unbuildable, and each ruling was about a
// different thing:
//
//   - `rev_per_install` (2026-09-04): ruled "no install event exists
//     anywhere in the product; needs SDK-side work first". No SDK work
//     was needed. `resolveOrCreateSubscriber` is reachable only from the
//     SDK's public-key /v1 surface, so creating a subscriber there IS an
//     install; it now stamps `subscribers.sdkInstalledAt`, and the
//     column was backfilled from the `platform` attribute the same path
//     had always written. See services/metrics/installs.ts, which is the
//     one definition of an install in the codebase.
//   - `liability` (2026-09-04): ruled "no balance history is retained
//     anywhere, so a line would be fabricated". `credit_ledger` retains
//     it — append-only, with both the signed delta and the balance after
//     it on every row. `getCreditLiabilityDaily` walks today's
//     authoritative outstanding figure backwards through the window's
//     deltas, so the last point equals the /credits gauge by
//     construction. Postgres only: this case issues no CH query.
//   - `retention_curve` and `ltv` (2026-09-04): ruled cohort-shaped, and
//     that ruling was RIGHT — both are lines over periods since cohort
//     start, not over calendar dates, and forcing them onto
//     `ChartSeriesPoint.bucket` would have fabricated dates. What was
//     missing was a way for a response to SAY so. `ChartSeriesAxis`
//     (@rovenue/shared) now does; both ids serve `axis: "period"`, and
//     the catalog's long-standing `chartType: "line"` finally describes
//     them. `/cohorts` keeps the arbitrary-rule heatmap — this is the
//     catalog's fixed-cohort view of the same data.

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
    // Every daily reader inherits this; the two cohort readers below
    // override it with `axis: "period"`. See ChartSeriesAxis in
    // @rovenue/shared for why the field is required rather than
    // defaulted.
    axis: "date" as const,
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

    case "rev_per_install": {
      // Net revenue ÷ installs, per day. The numerator is the same
      // `listDailyMrr` column `arpu` and `gross_vs_net` already read —
      // no second revenue query — and the denominator is installs.ts,
      // the only definition of an install in the codebase.
      //
      // SAME-DAY over SAME-DAY, deliberately: this is a daily
      // efficiency ratio, not lifetime revenue attributed to an install
      // cohort. The cohort-attributed question is exactly what the
      // `ltv` curve answers (see the cohort group below), so the two are
      // complements and neither reader has to invent an attribution
      // model. Both inputs ride along as numerator/denominator.
      assertClickHouseReady();
      const [mrrRows, installRows] = await Promise.all([
        listDailyMrr({ projectId, from: w.from, to: w.to }),
        getInstallsDaily({ projectId, from: w.from, to: w.to }),
      ]);
      return {
        ...base,
        unit: "money",
        points: buildPerInstallPoints(mrrRows, installRows, w.from, w.to),
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

    // =============================================================
    // Credits group: credit_burn (CH) and liability (PG).
    // =============================================================

    case "credit_burn": {
      // Credits spent per day. No new SQL: credits.ts's `readVolume`
      // already groups its CH query by day for the credits rollup's
      // volume chart; `getCreditBurnDaily` just re-shapes that same
      // query's `burned` column into this dispatcher's plain daily-
      // count shape. See getCreditBurnDaily's doc comment (credits.ts)
      // for the `burned` sign convention — it arrives as a positive
      // magnitude already, normalised defensively either way.
      //
      // Unit is `count`, not `money`: credits are a unit of account,
      // not USD (see credits.ts's readPackages comment on why revenue
      // stays separate from credit volume).
      assertClickHouseReady();
      const rows = await getCreditBurnDaily(projectId, w);
      return {
        ...base,
        unit: "count",
        points: buildCountSeriesPoints(rows, w.from, w.to),
        supported: true,
      };
    }

    // =============================================================
    // Cohort group: retention_curve and ltv.
    // =============================================================
    //
    // The only two ids on a PERIOD axis. They are lines — the catalog
    // has always said so — but lines over periods since cohort start,
    // not over calendar dates, which is why they could not be served
    // until `ChartSeriesAxis` existed to say which. Both use the same
    // fixed cohort (see catalogCohortRule in services/cohorts.ts), so
    // the two panels describe the same population.

    case "retention_curve": {
      assertClickHouseReady();
      const shape = catalogCohortShape(w.days);
      const r = await computeRetention({
        projectId,
        rule: catalogCohortRule(w.from, w.to),
        granularity: shape.granularity,
        periods: shape.periods,
      });
      return {
        ...base,
        axis: "period",
        periodGranularity: shape.granularity,
        unit: "percent",
        // An empty cohort has an UNDEFINED retention, not a 0% one —
        // the same distinction buildRatePoints draws for a zero
        // denominator.
        points: r.points.map((p) => ({
          period: p.period,
          value: r.size > 0 ? p.pct : null,
          numerator: p.active,
          denominator: r.size,
        })),
        supported: true,
      };
    }

    case "ltv": {
      // Cumulative net revenue per cohort MEMBER at each period — the
      // standard LTV curve. `v_revenue_lifetime_subscriber` (the view
      // behind `getLtvDistribution` and `avgLtvUsd`) cannot produce
      // this: it has no day dimension at all. See computeCohortLtvCurve.
      assertClickHouseReady();
      const shape = catalogCohortShape(w.days);
      const curve = await computeCohortLtvCurve({
        projectId,
        rule: catalogCohortRule(w.from, w.to),
        granularity: shape.granularity,
        periods: shape.periods,
      });
      return {
        ...base,
        axis: "period",
        periodGranularity: shape.granularity,
        unit: "money",
        points: curve.points.map((p) => ({
          period: p.period,
          value: curve.size > 0 ? p.cumulativeNetUsd / curve.size : null,
          numerator: p.cumulativeNetUsd,
          denominator: curve.size,
        })),
        supported: true,
      };
    }

    case "liability": {
      // Outstanding credit balance per day, from credits.ts — the
      // service that owns the gauge this line has to end on.
      //
      // NO assertClickHouseReady() here, deliberately: the ledger is
      // Postgres and a blank ClickHouse must not blank this chart. Same
      // position as `trials_started` and `churn`.
      //
      // Unit is `count`, not `money`: credits are a unit of account
      // (the same ruling `credit_burn` carries above). The rollup's
      // USD reserve figure is not reconstructible historically — see
      // getCreditLiabilityDaily's doc comment.
      const rows = await getCreditLiabilityDaily(projectId, {
        from: w.from,
        to: w.to,
        days: w.days,
      });
      return {
        ...base,
        unit: "count",
        points: buildCountSeriesPoints(rows, w.from, w.to),
        supported: true,
      };
    }

    default:
      // Not an error, and no longer the catalog's normal state: every
      // SYSTEM id has a reader (chart-catalog.test.ts asserts it). This
      // is the answer for an id the dispatcher does not know — a custom
      // chart, or a typo.
      //
      // No `assertClickHouseReady()` and no query above this line — an
      // unsupported id must cost zero ClickHouse round-trips, or one
      // chart's data leaks out under another's name.
      return { ...base, unit: "count", points: [], supported: false };
  }
}
