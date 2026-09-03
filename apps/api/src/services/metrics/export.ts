import type {
  ChartChannelsResponse,
  ChartFunnelResponse,
  ChartHeatmapResponse,
  ChartProceedsResponse,
  ChartSeriesResponse,
} from "@rovenue/shared";
import { csvEscape } from "../subscriptions/export-csv";
import {
  readChannels,
  readChartSeries,
  readFunnel,
  readHeatmap,
  readProceeds,
} from "./charts";
import { SYSTEM_CHART_IDS } from "./chart-catalog";

// =============================================================
// Metrics export for customer BI (Task 6, 2026-09-01
// analytics-integrity-and-proceeds design spec §4.4)
// =============================================================
//
// This is a customer-BI CSV built ENTIRELY on top of the existing
// chart readers (`readChannels` / `readProceeds` / `readFunnel` /
// `readHeatmap` / `readChartSeries`) — it issues zero ClickHouse
// queries of its own. Two reasons, both from the design spec and the
// task context, not a style preference:
//
//   1. A second query set drifts from the first over time.
//   2. The schema-contract test (schema-contract.integration.test.ts)
//      only protects queries it can reach — it reflects over specific
//      modules' exports. A fresh query here would either need its own
//      wiring into that harness or sit outside it entirely. Reusing
//      already-wired readers means this file inherits their coverage
//      for free and needs none of its own.
//
// Shape: one CSV, "long"/tidy format — one row per (entity, metric)
// pair rather than a wide table per section, because the five
// sections have unrelated grains (per-store, per-funnel-step,
// per-(dow,hour) cell, per-day-per-chart-id) and forcing them into a
// shared wide schema would produce a column explosion of mostly-empty
// cells. `kind` distinguishes the section; the columns that don't
// apply to a given kind are blank.
//
// PII: this export carries only aggregate metrics (per-store sums,
// funnel counts, heatmap cell counts, daily chart-series points) —
// never a subscriber id, email, or any row keyed to an individual
// person. The import feature's retention/anonymization machinery
// exists to bound exposure of end-user PII; there is none here to
// bound, so this module deliberately does not use it.

const COLUMNS = [
  "kind",
  "chart_id",
  "store",
  "bucket",
  "dow",
  "hour",
  "step",
  "metric",
  "value",
  "unit",
] as const;

/**
 * Hard cap on rows emitted, mirroring `export-csv.ts`'s `HARD_CAP` —
 * named so no magic number appears at the call sites, and large
 * enough that no real project's data can hit it under normal
 * windows (≤365 series-days × the system chart catalog, plus a
 * handful of per-store/per-step/per-cell rows) while still bounding
 * memory/response size against a pathological catalog growth.
 */
export const METRICS_EXPORT_ROW_CAP = 50_000;

type MetricsExportUnit = "usd" | "ratio" | "percent" | "count";

export interface MetricsExportRow {
  kind: "channels" | "proceeds" | "funnel" | "heatmap" | "series";
  chartId: string | null;
  store: string | null;
  bucket: string | null;
  dow: number | null;
  hour: number | null;
  step: string | null;
  metric: string;
  value: string;
  unit: MetricsExportUnit;
}

export type MetricsExportParams = {
  projectId: string;
  windowDays: number;
};

export interface MetricsExportSummary {
  rowCount: number;
  truncated: boolean;
  /**
   * Chart ids whose reader threw mid-stream (Task 6 — the catalog grew
   * from 2 wired readers to a dozen, so a single bad reader is no
   * longer a rare event). Each failing id gets its own `# error:` line
   * in the body and is skipped; every OTHER id still streams normally.
   * Empty in the common case.
   */
  erroredChartIds: string[];
}

// =============================================================
// Pure helpers — row shaping, header/line formatting
// =============================================================

function baseRow(
  fields: Pick<MetricsExportRow, "kind" | "metric" | "value" | "unit"> &
    Partial<
      Pick<MetricsExportRow, "chartId" | "store" | "bucket" | "dow" | "hour" | "step">
    >,
): MetricsExportRow {
  return {
    kind: fields.kind,
    chartId: fields.chartId ?? null,
    store: fields.store ?? null,
    bucket: fields.bucket ?? null,
    dow: fields.dow ?? null,
    hour: fields.hour ?? null,
    step: fields.step ?? null,
    metric: fields.metric,
    value: fields.value,
    unit: fields.unit,
  };
}

function numOrBlank(n: number | null): string {
  return n === null ? "" : String(n);
}

function channelsToRows(r: ChartChannelsResponse): MetricsExportRow[] {
  const rows: MetricsExportRow[] = [];
  for (const row of r.rows) {
    rows.push(
      baseRow({
        kind: "channels",
        store: row.store,
        metric: "gross_usd",
        value: row.grossUsd,
        unit: "usd",
      }),
    );
    rows.push(
      baseRow({
        kind: "channels",
        store: row.store,
        metric: "pct",
        value: String(row.pct),
        unit: "percent",
      }),
    );
    rows.push(
      baseRow({
        kind: "channels",
        store: row.store,
        metric: "event_count",
        value: String(row.eventCount),
        unit: "count",
      }),
    );
  }
  return rows;
}

function proceedsToRows(r: ChartProceedsResponse): MetricsExportRow[] {
  const rows: MetricsExportRow[] = [];
  for (const row of r.rows) {
    rows.push(
      baseRow({
        kind: "proceeds",
        store: row.store,
        metric: "gross_usd",
        value: row.grossUsd,
        unit: "usd",
      }),
    );
    rows.push(
      baseRow({
        kind: "proceeds",
        store: row.store,
        metric: "refunds_usd",
        value: row.refundsUsd,
        unit: "usd",
      }),
    );
    rows.push(
      baseRow({
        kind: "proceeds",
        store: row.store,
        metric: "net_usd",
        value: row.netUsd,
        unit: "usd",
      }),
    );
    // rate/proceeds_usd travel together: a store with no configured
    // rate gets BOTH blank, never a silent 0% — same contract
    // `readProceeds` itself guarantees (charts.ts, Task 5).
    rows.push(
      baseRow({
        kind: "proceeds",
        store: row.store,
        metric: "rate",
        value: row.rate === null ? "" : String(row.rate),
        unit: "ratio",
      }),
    );
    rows.push(
      baseRow({
        kind: "proceeds",
        store: row.store,
        metric: "proceeds_usd",
        value: row.proceedsUsd ?? "",
        unit: "usd",
      }),
    );
  }
  return rows;
}

function funnelToRows(r: ChartFunnelResponse): MetricsExportRow[] {
  const rows: MetricsExportRow[] = [];
  for (const step of r.steps) {
    rows.push(
      baseRow({
        kind: "funnel",
        step: step.key,
        metric: "count",
        value: String(step.count),
        unit: "count",
      }),
    );
    rows.push(
      baseRow({
        kind: "funnel",
        step: step.key,
        metric: "pct",
        value: String(step.pct),
        unit: "percent",
      }),
    );
  }
  return rows;
}

function heatmapToRows(r: ChartHeatmapResponse): MetricsExportRow[] {
  return r.cells.map((cell) =>
    baseRow({
      kind: "heatmap",
      dow: cell.dow,
      hour: cell.hour,
      metric: "count",
      value: String(cell.count),
      unit: "count",
    }),
  );
}

// ChartSeriesResponse's money unit is spelled "usd" everywhere else in
// this export (see the `unit: "usd"` rows above) — map rather than
// assign directly so "count"/"percent" keep passing through unchanged
// (identical to before the money unit existed) and "money" lands on
// this file's own vocabulary instead of silently widening it.
const SERIES_UNIT_TO_EXPORT_UNIT: Record<
  ChartSeriesResponse["unit"],
  MetricsExportUnit
> = {
  count: "count",
  percent: "percent",
  money: "usd",
};

function seriesToRows(r: ChartSeriesResponse): MetricsExportRow[] {
  if (!r.supported) return [];
  return r.points.map((p) =>
    baseRow({
      kind: "series",
      chartId: r.chartId,
      bucket: p.bucket,
      metric: "value",
      value: p.value === null ? "" : String(p.value),
      unit: SERIES_UNIT_TO_EXPORT_UNIT[r.unit],
    }),
  );
}

export function formatMetricsExportHeader(): string {
  return `${COLUMNS.join(",")}\n`;
}

export function formatMetricsExportRow(r: MetricsExportRow): string {
  const cells = [
    r.kind,
    r.chartId ?? "",
    r.store ?? "",
    r.bucket ?? "",
    numOrBlank(r.dow),
    numOrBlank(r.hour),
    r.step ?? "",
    r.metric,
    r.value,
    r.unit,
  ].map(csvEscape);
  return `${cells.join(",")}\n`;
}

function formatTruncationMarker(cap: number): string {
  return `# truncated at ${cap} rows\n`;
}

function formatSeriesErrorMarker(chartId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Same "#"-prefixed comment convention as the truncation marker —
  // every CSV reader we care about ignores a "#" line, and a consumer
  // that cares can grep for it. Scoped to the one chart id that failed
  // (`chart_id=<id>`) rather than the single unqualified `# error:`
  // line the route's catch-all uses for a section-wide failure, so a
  // customer can tell "arr failed" from "the whole export failed".
  return `# error: chart_id=${chartId}: ${message}\n`;
}

// =============================================================
// Per-chart-id series fan-out
// =============================================================
//
// SYSTEM_CHART_IDS has grown from 2 wired readers to a dozen (Tasks
// 2-5). Fetching them one at a time, awaiting each before starting the
// next, turns this loop into a dozen sequential ClickHouse/Postgres
// round trips per export request — a real increase in per-request
// work regardless of whether it was timed. `readChartSeries`'s own
// `paywall_view_rate` case already sets the precedent for running
// independent reads concurrently (`Promise.all` there); this does the
// same across the whole catalog.
//
// `Promise.allSettled`, not `Promise.all`: with a dozen real readers a
// single one throwing is no longer rare, and a `Promise.all` rejection
// would still take the whole batch down together — exactly the
// mid-stream "one bad reader kills the export" failure mode this task
// exists to close. Settling each one individually means a failing
// reader's rejection never reaches the caller as a thrown error; it is
// captured, reported as its own marker line, and every other id's
// result streams normally.
type SeriesFanOutResult =
  | { chartId: string; ok: true; series: ChartSeriesResponse }
  | { chartId: string; ok: false; error: unknown };

async function readAllChartSeries(
  projectId: string,
  windowDays: number,
): Promise<SeriesFanOutResult[]> {
  const ids = [...SYSTEM_CHART_IDS];
  const settled = await Promise.allSettled(
    ids.map((chartId) => readChartSeries(projectId, chartId, windowDays)),
  );
  return settled.map((result, i) => {
    const chartId = ids[i]!;
    return result.status === "fulfilled"
      ? { chartId, ok: true, series: result.value }
      : { chartId, ok: false, error: result.reason };
  });
}

// =============================================================
// Streaming generator
// =============================================================

export async function* streamMetricsExportCsv(
  params: MetricsExportParams,
  cap: number = METRICS_EXPORT_ROW_CAP,
): AsyncGenerator<string, MetricsExportSummary, void> {
  const { projectId, windowDays } = params;
  yield formatMetricsExportHeader();

  let rowCount = 0;
  const erroredChartIds: string[] = [];

  // Yields each row's CSV line and, once `cap` is reached, the
  // truncation marker; returns whether the cap was hit so the caller
  // can stop pulling further sections/readers immediately — a
  // silently truncated export (one that just stops, with no marker)
  // is worse than an error because a customer's BI would report
  // quietly incomplete numbers.
  function* emit(rows: MetricsExportRow[]): Generator<string, boolean, void> {
    for (const row of rows) {
      yield formatMetricsExportRow(row);
      rowCount += 1;
      if (rowCount >= cap) {
        yield formatTruncationMarker(cap);
        return true;
      }
    }
    return false;
  }

  const channels = await readChannels(projectId, windowDays);
  if (yield* emit(channelsToRows(channels))) {
    return { rowCount, truncated: true, erroredChartIds };
  }

  const proceeds = await readProceeds(projectId, windowDays);
  if (yield* emit(proceedsToRows(proceeds))) {
    return { rowCount, truncated: true, erroredChartIds };
  }

  const funnel = await readFunnel(projectId, windowDays);
  if (yield* emit(funnelToRows(funnel))) {
    return { rowCount, truncated: true, erroredChartIds };
  }

  const heatmap = await readHeatmap(projectId, windowDays);
  if (yield* emit(heatmapToRows(heatmap))) {
    return { rowCount, truncated: true, erroredChartIds };
  }

  // Fired concurrently (see readAllChartSeries above) — a failing id
  // is settled, not thrown, so it cannot unwind this generator and
  // cannot stop any other id's rows from streaming.
  const seriesResults = await readAllChartSeries(projectId, windowDays);
  for (const result of seriesResults) {
    if (!result.ok) {
      erroredChartIds.push(result.chartId);
      yield formatSeriesErrorMarker(result.chartId, result.error);
      continue;
    }
    if (yield* emit(seriesToRows(result.series))) {
      return { rowCount, truncated: true, erroredChartIds };
    }
  }

  return { rowCount, truncated: false, erroredChartIds };
}
