import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChartSeries } from "../../lib/hooks/useChartSeries";
import { formatCount } from "./format";
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
// Cap mirrors the API's own clamp (WINDOW_MAX_DAYS in
// apps/api/src/services/metrics/charts.ts) so "All" doesn't request
// a window the server would silently truncate anyway.
const MAX_WINDOW_DAYS = 365;

export function rangeToWindowDays(range: RangeOption): number {
  return Math.min(RANGE_MONTHS[range] * DAYS_PER_MONTH, MAX_WINDOW_DAYS);
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

  const yMax =
    Math.max(...plotted.map((p) => p.value), MIN_Y_MAX) * Y_HEADROOM;

  const x = (i: number) =>
    PAD_L + (points.length <= 1 ? 0 : (i / (points.length - 1)) * INNER_W);
  const y = (v: number) => PAD_T + (1 - v / yMax) * INNER_H;

  const formatValue = (v: number) =>
    unit === "percent" ? `${v.toFixed(1)}%` : formatCount(v);

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
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-[240px] w-full"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((g) => {
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
