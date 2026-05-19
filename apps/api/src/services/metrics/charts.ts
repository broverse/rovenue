import type {
  ChartChannelsResponse,
  ChartChannelsRow,
  ChartFunnelResponse,
  ChartFunnelStep,
  ChartHeatmapCell,
  ChartHeatmapResponse,
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

export const __chartsConstants = {
  WINDOW_DEFAULT_DAYS: 28,
  WINDOW_MAX_DAYS,
};
