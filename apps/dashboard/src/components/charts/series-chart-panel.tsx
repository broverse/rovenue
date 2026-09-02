import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChartSeries } from "../../lib/hooks/useChartSeries";
import { formatCount, formatCurrencyCompact } from "./format";
import { RANGE_MONTHS } from "./mrr-chart-panel";
import type { ChartType, RangeOption } from "./types";

// =============================================================
// Series chart panel — backed by GET /charts/series/:chartId
// =============================================================
//
// One generic renderer for every catalog chart id *except* `mrr`
// (which keeps its own bespoke panel — see mrr-chart-panel.tsx).
// `supported: false` (an id with no reader wired yet) renders an
// honest empty state; it must never fall back to rendering some
// other chart's data, which is the bug this panel exists to fix.
//
// `ChartSeriesPoint.value` is `null` when the metric is undefined
// for that day (e.g. a ratio with a zero denominator) — distinct
// from a measured 0. A null point is rendered as a gap: it breaks
// the line/bar for that day rather than plotting a false floor.

const W = 800;
const H = 240;
const PAD_L = 48;
const PAD_R = 16;
const PAD_T = 20;
const PAD_B = 28;
const INNER_W = W - PAD_L - PAD_R;
const INNER_H = H - PAD_T - PAD_B;

// A day with no measured value at all (loading, or a genuinely
// empty supported series) still needs a floor for the axes to draw
// against.
const MIN_Y_MAX = 1;
// Headroom above the tallest point so it doesn't touch the top edge.
const Y_HEADROOM = 1.1;

const DAYS_PER_MONTH = 30;
// Cap mirrors the API's own clamp (WINDOW_MAX_DAYS / windowQuerySchema's
// `.max()` in apps/api/src/routes/dashboard/charts.ts, sourced from
// __chartsConstants in apps/api/src/services/metrics/charts.ts). The
// server does NOT silently truncate an over-cap request — it 400s —
// so this client-side clamp exists to keep "All" (24mo ≈ 720d) from
// ever reaching the server as a request the API will reject outright.
const MAX_WINDOW_DAYS = 365;

// How many gridlines / y-axis labels to draw — mirrors MrrChartPanel's
// 5-tick convention (see mrr-chart-panel.tsx) so both panels read as
// the same product.
const Y_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;
// How many x-axis date labels to draw. Unlike MrrChartPanel (which
// labels every month, at most 24), this panel can have up to
// MAX_WINDOW_DAYS daily points — labelling every day would be
// unreadable, so we sample a fixed, small number of evenly-spaced
// ticks instead.
const X_TICK_COUNT = 6;

// Label styling/positioning — lifted from MrrChartPanel's axis-label
// conventions (same font size, same gutter offsets) so the two panels
// look like the same product.
const AXIS_LABEL_FONT_SIZE = 10;
const Y_LABEL_GUTTER_OFFSET = 10; // distance left of PAD_L, text-anchor "end"
const Y_LABEL_BASELINE_NUDGE = 3; // vertical nudge so the label centers on the gridline
const X_LABEL_BOTTOM_OFFSET = 16; // distance up from the svg's bottom edge

// Decimal places for a "percent" unit's axis/tooltip label, e.g. "0.4%".
const PERCENT_DECIMALS = 1;

export function rangeToWindowDays(range: RangeOption): number {
  return Math.min(RANGE_MONTHS[range] * DAYS_PER_MONTH, MAX_WINDOW_DAYS);
}

/** Whether `range`'s nominal span exceeds what the server will serve
 * (currently only "All", whose 24mo nominal span is ~720d). Used to
 * tell the user the truncated window they're actually getting instead
 * of silently showing "All" over a shorter span. */
export function isRangeWindowTruncated(range: RangeOption): boolean {
  return RANGE_MONTHS[range] * DAYS_PER_MONTH > MAX_WINDOW_DAYS;
}

/** Format a bucket's ISO timestamp as a short UTC date label, e.g. "Jul 3". */
function formatDayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Pick up to `tickCount` evenly-spaced indices into a 0..count-1
 * range, always including the first and last index. Used to sample a
 * readable number of x-axis labels out of up to 365 daily points. */
function pickTickIndices(count: number, tickCount: number): number[] {
  if (count <= 0) return [];
  if (count <= tickCount) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (tickCount - 1);
  const seen = new Set<number>();
  for (let i = 0; i < tickCount; i++) {
    seen.add(Math.round(i * step));
  }
  return [...seen].sort((a, b) => a - b);
}

type Props = {
  projectId: string;
  chartId: string;
  chartType: ChartType;
  range: RangeOption;
};

interface PlottedPoint {
  i: number;
  value: number;
}

export function SeriesChartPanel({ projectId, chartId, chartType, range }: Props) {
  const { t } = useTranslation();
  const windowDays = rangeToWindowDays(range);
  const { data, isLoading, error } = useChartSeries({
    projectId,
    chartId,
    windowDays,
  });

  const points = data?.points ?? [];
  const unit = data?.unit ?? "count";

  // Contiguous runs of non-null values. A null point ends the
  // current run instead of joining it — that's what turns a gap
  // into a visual break rather than a dip to zero.
  const runs = useMemo(() => {
    const out: PlottedPoint[][] = [];
    let current: PlottedPoint[] = [];
    for (const [i, p] of points.entries()) {
      if (p.value === null) {
        if (current.length > 0) out.push(current);
        current = [];
        continue;
      }
      current.push({ i, value: p.value });
    }
    if (current.length > 0) out.push(current);
    return out;
  }, [points]);

  const plotted = useMemo(() => runs.flat(), [runs]);

  // A supported chart whose every day came back null (e.g. a brand
  // new project) is distinct from `supported: false` — the reader
  // exists, it just has nothing to say about this window.
  const hasVisibleData = plotted.length > 0;

  const yMax =
    Math.max(...plotted.map((p) => p.value), MIN_Y_MAX) * Y_HEADROOM;

  const x = (i: number) =>
    PAD_L + (points.length <= 1 ? 0 : (i / (points.length - 1)) * INNER_W);
  const y = (v: number) => PAD_T + (1 - v / yMax) * INNER_H;

  // Money is always USD — the API normalises every revenue figure to
  // amountUsd, so there is no currency to select here.
  const formatValue = (v: number) =>
    unit === "percent"
      ? `${v.toFixed(PERCENT_DECIMALS)}%`
      : unit === "money"
        ? formatCurrencyCompact(v)
        : formatCount(v);

  // Axis labels: y is the same 5-fraction ticks as the gridlines,
  // formatted per-unit so a percent series never looks like a count
  // series. x is a small, fixed sample of the day labels — see
  // pickTickIndices.
  const yAxisTicks = useMemo(
    () =>
      Y_TICK_FRACTIONS.map((frac) => ({
        frac,
        value: (1 - frac) * yMax,
      })),
    [yMax],
  );
  const xAxisTickIndices = useMemo(
    () => pickTickIndices(points.length, X_TICK_COUNT),
    [points.length],
  );

  const windowTruncated = isRangeWindowTruncated(range);
  // Read the served span off the RESPONSE, not off `range`. The client's
  // own cap and the server's `windowQuerySchema.max()` are two constants
  // either side of a service boundary; recomputing the number here would
  // state a stale figure the moment they drift — which is the exact
  // silent mismatch this note exists to remove. `points` is one entry per
  // day in the window the server actually built.
  const servedDays = points.length;

  if (error) {
    return (
      <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
        <div
          data-testid="series-chart-error"
          className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[11px] text-rv-danger"
        >
          {t("charts.series.loadError")}
        </div>
      </section>
    );
  }

  if (isLoading) {
    return (
      <section
        data-testid="series-chart-loading"
        className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4"
      >
        <div className="font-rv-mono text-[28px] font-medium tabular-nums text-rv-mute-500">
          —
        </div>
      </section>
    );
  }

  if (!data || data.supported === false) {
    return (
      <section
        data-testid="series-chart-empty"
        className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-8 text-center"
      >
        <div className="font-rv-mono text-[13px] font-medium text-rv-mute-700">
          {t("charts.series.emptyTitle")}
        </div>
        <p className="mt-1 text-[12px] text-rv-mute-500">
          {t("charts.series.emptyBody")}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      {windowTruncated && (
        <p
          data-testid="series-chart-window-note"
          className="mb-2 text-[11px] text-rv-mute-500"
        >
          {t("charts.series.windowCapped", { days: servedDays })}
        </p>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-[240px] w-full"
      >
        {Y_TICK_FRACTIONS.map((g) => {
          const gy = PAD_T + g * INNER_H;
          return (
            <line
              key={g}
              x1={PAD_L}
              x2={W - PAD_R}
              y1={gy}
              y2={gy}
              stroke="var(--color-rv-divider)"
              strokeDasharray="3 3"
            />
          );
        })}

        {yAxisTicks.map(({ frac, value }) => (
          <text
            key={frac}
            data-testid={`series-chart-ylabel-${frac}`}
            x={PAD_L - Y_LABEL_GUTTER_OFFSET}
            y={PAD_T + frac * INNER_H + Y_LABEL_BASELINE_NUDGE}
            fontSize={AXIS_LABEL_FONT_SIZE}
            fill="var(--color-rv-mute-500)"
            textAnchor="end"
            fontFamily="var(--font-rv-mono)"
          >
            {formatValue(value)}
          </text>
        ))}

        {xAxisTickIndices.map((i) => (
          <text
            key={i}
            data-testid={`series-chart-xlabel-${i}`}
            x={x(i)}
            y={H - X_LABEL_BOTTOM_OFFSET}
            fontSize={AXIS_LABEL_FONT_SIZE}
            fill="var(--color-rv-mute-500)"
            textAnchor="middle"
            fontFamily="var(--font-rv-mono)"
          >
            {formatDayLabel(points[i]!.bucket)}
          </text>
        ))}

        {!hasVisibleData && (
          <text
            data-testid="series-chart-no-data"
            x={PAD_L + INNER_W / 2}
            y={PAD_T + INNER_H / 2}
            fontSize={AXIS_LABEL_FONT_SIZE}
            fill="var(--color-rv-mute-500)"
            textAnchor="middle"
            fontFamily="var(--font-rv-mono)"
          >
            {t("charts.series.noDataInWindow")}
          </text>
        )}

        {chartType === "bar" ? (
          points.map((p, i) => {
            if (p.value === null) return null;
            const bw = (INNER_W / Math.max(points.length, 1)) * 0.6;
            return (
              <rect
                key={i}
                data-testid={`series-chart-point-${i}`}
                x={x(i) - bw / 2}
                y={y(p.value)}
                width={bw}
                height={PAD_T + INNER_H - y(p.value)}
                fill="var(--color-rv-accent-500)"
                rx={2}
              >
                <title>{formatValue(p.value)}</title>
              </rect>
            );
          })
        ) : (
          <>
            {runs.map((run, ri) => {
              const d = run
                .map(
                  (pt, idx) =>
                    `${idx === 0 ? "M" : "L"}${x(pt.i).toFixed(1)},${y(pt.value).toFixed(1)}`,
                )
                .join(" ");
              return (
                <path
                  key={ri}
                  d={
                    chartType === "area"
                      ? `${d} L ${x(run[run.length - 1]!.i)},${PAD_T + INNER_H} L ${x(run[0]!.i)},${PAD_T + INNER_H} Z`
                      : d
                  }
                  fill={chartType === "area" ? "var(--color-rv-accent-500)" : "none"}
                  fillOpacity={chartType === "area" ? 0.15 : undefined}
                  stroke="var(--color-rv-accent-500)"
                  strokeWidth="2"
                />
              );
            })}
            {points.map((p, i) => {
              if (p.value === null) return null;
              return (
                <circle
                  key={i}
                  data-testid={`series-chart-point-${i}`}
                  cx={x(i)}
                  cy={y(p.value)}
                  r={2.5}
                  fill="var(--color-rv-accent-500)"
                  stroke="var(--color-rv-c1)"
                  strokeWidth="1"
                >
                  <title>{formatValue(p.value)}</title>
                </circle>
              );
            })}
          </>
        )}
      </svg>
    </section>
  );
}
