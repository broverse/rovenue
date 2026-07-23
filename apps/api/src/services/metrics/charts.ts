import type {
  ChartChannelsResponse,
  ChartChannelsRow,
  ChartFilterOption,
  ChartFilterOptionsResponse,
  ChartFunnelResponse,
  ChartFunnelStep,
  ChartHeatmapCell,
  ChartHeatmapResponse,
  ChartSeriesPoint,
  ChartSeriesResponse,
} from "@rovenue/shared";
import {
  ClickHouseUnavailableError,
  isClickHouseConfigured,
  queryAnalytics,
} from "../../lib/clickhouse";

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
// distinct (platform, country, productGroupId) values that are
// actually present in the project's CH data so users aren't
// presented with options that can't match anything.
//
// `country` falls back to `subscriberCountry` when the event
// payload didn't carry one — same convention used by the
// overview cohort heatmap.

interface ChDistinctRow {
  value: string;
  c: string;
}

async function distinctDimension(
  projectId: string,
  expr: string,
  from: string,
  to: string,
  limit = 50,
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

export async function readFilterOptions(
  projectId: string,
  windowDays: number,
): Promise<ChartFilterOptionsResponse> {
  assertClickHouseReady();
  const w = buildWindow(windowDays);
  const from = toDateOnly(w.from);
  const to = toDateOnly(w.to);

  const [platform, country, productGroup] = await Promise.all([
    // `store` is the platform discriminator in raw events.
    distinctDimension(projectId, "store", from, to),
    distinctDimension(
      projectId,
      "ifNull(nullIf(subscriberCountry, ''), country)",
      from,
      to,
    ),
    // Product group identifier travels on the event as
    // `productGroupId`; some legacy rows are NULL — the filter on
    // `expr != ''` strips them.
    distinctDimension(projectId, "ifNull(productGroupId, '')", from, to),
  ]);

  return {
    windowDays: w.days,
    platform,
    country,
    productGroup,
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

// =============================================================
// Generic chart series — paywall reach and conversion
// =============================================================
//
// Two of the sixteen catalog charts are wired. Every other id
// answers `supported: false` so the dashboard renders an empty
// state rather than another chart's data.

/** Revenue event types that count as a purchase for attribution. */
const PURCHASE_EVENT_TYPES = "'INITIAL', 'RENEWAL', 'TRIAL_CONVERSION', 'REACTIVATION'";

/** Catalog ids this service can serve today. */
const SUPPORTED_SERIES_IDS: ReadonlySet<string> = new Set([
  "paywall_view_rate",
  "paywall_purchase",
]);

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

  if (!SUPPORTED_SERIES_IDS.has(chartId)) {
    // Not an error: most of the catalog simply has no reader yet.
    return { ...base, unit: "count", points: [], supported: false };
  }

  assertClickHouseReady();
  const from = toDateOnly(w.from);
  const to = toDateOnly(w.to);

  if (chartId === "paywall_view_rate") {
    // Reach: what share of the day's active subscribers saw a paywall.
    const viewers = await readPaywallViewers(projectId, from, to);
    // NOTE: `sdk_sessions_daily_tbl` (0010) was dropped by migration
    // 0016_sdk_sessions_idempotent.sql — the SummingMergeTree rollup
    // double-counted replayed outbox events, same failure mode as the
    // revenue rollups (see 0012). `v_sdk_sessions_daily` is the
    // query-time-deduped replacement (FINAL over raw_sdk_session_events)
    // and is what every current caller reads from.
    //
    // Select the bare `day` column (not `toString(day) AS day`) — see
    // readPaywallViewers for why the re-alias trips ClickHouse's
    // GROUP BY/ORDER BY substitution against the WHERE clause.
    const actives = await queryAnalytics<DailyCountRow>(
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
    return {
      ...base,
      unit: "percent",
      points: buildRatePoints(viewers, actives, w.from, w.to),
      supported: true,
    };
  }

  // paywall_purchase — conversion: what share of paywall viewers bought.
  //
  // Precise attribution, mirroring analytics-router's placement_metrics:
  // raw_revenue_events carries the purchase's originating paywallId
  // (migration 0019), so no viewer-overlap heuristic is needed.
  //
  // KNOWN HORIZON: rows written before 0019 carry paywallId = '' and
  // cannot match, so this chart under-reports for dates before that
  // migration was deployed. That is the data, not a bug — do not
  // "fix" it by dropping the filter, which would attribute every
  // purchase to a paywall.
  const purchasers = await queryAnalytics<DailyCountRow>(
    projectId,
    `
      SELECT
        toString(toDate(eventDate))       AS day,
        toString(uniq(subscriberId))      AS n
      FROM rovenue.raw_revenue_events
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
        AND paywallId != ''
        AND type IN (${PURCHASE_EVENT_TYPES})
      GROUP BY day
      ORDER BY day
    `,
    { projectId, from, to },
  );
  const viewers = await readPaywallViewers(projectId, from, to);
  return {
    ...base,
    unit: "percent",
    points: buildRatePoints(purchasers, viewers, w.from, w.to),
    supported: true,
  };
}
