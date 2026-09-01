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

function seriesToRows(r: ChartSeriesResponse): MetricsExportRow[] {
  if (!r.supported) return [];
  return r.points.map((p) =>
    baseRow({
      kind: "series",
      chartId: r.chartId,
      bucket: p.bucket,
      metric: "value",
      value: p.value === null ? "" : String(p.value),
      unit: r.unit,
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
    return { rowCount, truncated: true };
  }

  const proceeds = await readProceeds(projectId, windowDays);
  if (yield* emit(proceedsToRows(proceeds))) {
    return { rowCount, truncated: true };
  }

  const funnel = await readFunnel(projectId, windowDays);
  if (yield* emit(funnelToRows(funnel))) {
    return { rowCount, truncated: true };
  }

  const heatmap = await readHeatmap(projectId, windowDays);
  if (yield* emit(heatmapToRows(heatmap))) {
    return { rowCount, truncated: true };
  }

  for (const chartId of SYSTEM_CHART_IDS) {
    const series = await readChartSeries(projectId, chartId, windowDays);
    if (yield* emit(seriesToRows(series))) {
      return { rowCount, truncated: true };
    }
  }

  return { rowCount, truncated: false };
}
