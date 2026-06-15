import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "../../lib/cn";
import { formatCurrencyCompact } from "./format";
import { useProjectMrr } from "../../lib/hooks/useProjectMrr";
import { useChartAnnotations } from "../../lib/hooks/useProjectCharts";
import { useProjectMrrDecomposition } from "../../lib/hooks/useProjectMrrDecomposition";
import type { ChartType, RangeOption } from "./types";

// =============================================================
// MRR chart panel — backed by /metrics/mrr
// =============================================================
//
// The endpoint returns per-day buckets; this panel rolls them up
// into months so we can render the familiar 6/12/All-month line.
// Decomposition (New / Expansion / Contraction / Churn) still
// uses mock data — that breakdown isn't surfaced by the read API
// yet and is tracked as a separate follow-up.

const W = 800;
const H = 360;
const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 24;
const PAD_B = 38;
const INNER_W = W - PAD_L - PAD_R;
const INNER_H = H - PAD_T - PAD_B;

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const RANGE_MONTHS: Record<RangeOption, number> = {
  "1M": 1,
  "3M": 3,
  "6M": 6,
  "12M": 12,
  YTD: 12, // capped client-side once we know the current month
  All: 24,
};

type Props = {
  projectId: string;
  chartType: ChartType;
  compare: boolean;
  range: RangeOption;
};

interface MonthlyBucket {
  /** Year-month key, e.g. `2026-03`. */
  ym: string;
  /** Numeric month index 0..11 for the label. */
  month: number;
  /** Sum of grossUsd within the calendar month. */
  total: number;
  net: number;
  refunds: number;
}

function bucketKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}

function bucketLabel(ym: string): string {
  const m = Number(ym.slice(5));
  return MONTH_NAMES[m - 1] ?? "";
}

/**
 * Roll the API's daily series up to monthly totals, ordered
 * ascending. We always emit the most recent `n` months and pad
 * empty ones with zero so the chart spans the requested range
 * even when the project has gaps.
 */
function rollupToMonths(
  points: ReadonlyArray<{ bucket: string; grossUsd: string; netUsd: string; refundsUsd: string }>,
  months: number,
  now: Date,
): MonthlyBucket[] {
  const totals = new Map<string, number>();
  const nets = new Map<string, number>();
  const refunds = new Map<string, number>();
  for (const p of points) {
    const d = new Date(p.bucket);
    const key = bucketKey(d);
    totals.set(key, (totals.get(key) ?? 0) + Number(p.grossUsd));
    nets.set(key, (nets.get(key) ?? 0) + Number(p.netUsd));
    refunds.set(key, (refunds.get(key) ?? 0) + Number(p.refundsUsd));
  }
  const out: MonthlyBucket[] = [];
  // Walk back from `now` so the last entry is always "current month".
  const cursor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(cursor);
    d.setUTCMonth(d.getUTCMonth() - i);
    const ym = bucketKey(d);
    out.push({
      ym,
      month: d.getUTCMonth(),
      total: totals.get(ym) ?? 0,
      net: nets.get(ym) ?? 0,
      refunds: refunds.get(ym) ?? 0,
    });
  }
  return out;
}

export function MrrChartPanel({ projectId, chartType, compare, range }: Props) {
  const { t } = useTranslation();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // We split current + prev into two requests so each stays under
  // the API's per-call window cap. Going through the cap in a
  // single span was the prior bug behind "Couldn't load MRR" on
  // 12M+compare / All ranges.
  const months = RANGE_MONTHS[range];
  const now = useMemo(() => new Date(), []);

  // Floor to the first day of the month so the API doesn't return
  // a partial leading bucket that the monthly rollup would
  // double-count against `to`.
  const currentFrom = useMemo(() => {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() - (months - 1));
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }, [now, months]);
  const currentTo = useMemo(() => now.toISOString(), [now]);

  const prevTo = useMemo(() => {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() - months);
    return d.toISOString();
  }, [now, months]);
  const prevFrom = useMemo(() => {
    const d = new Date(prevTo);
    d.setUTCMonth(d.getUTCMonth() - (months - 1));
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }, [prevTo, months]);

  const currentQuery = useProjectMrr({
    projectId,
    from: currentFrom,
    to: currentTo,
  });
  const decomposition = useProjectMrrDecomposition({
    projectId,
    from: currentFrom,
    to: currentTo,
  });
  const prevQuery = useProjectMrr({
    projectId,
    from: prevFrom,
    to: prevTo,
    enabled: compare,
  });

  const series = useMemo(() => {
    const current = rollupToMonths(
      currentQuery.data?.points ?? [],
      months,
      now,
    );
    const prevAnchor = new Date(now);
    prevAnchor.setUTCMonth(prevAnchor.getUTCMonth() - months);
    const prev = compare
      ? rollupToMonths(prevQuery.data?.points ?? [], months, prevAnchor)
      : [];
    return { current, prev };
  }, [currentQuery.data, prevQuery.data, months, compare, now]);

  // Empty projects render an all-zero series spanning the requested
  // range so axes/labels still draw. Errors are surfaced separately
  // and never silently swap to anything else.
  const currentValues = useMemo(
    () => series.current.map((b) => b.total),
    [series.current],
  );
  const netValues = useMemo(
    () => series.current.map((b) => b.net),
    [series.current],
  );

  const prevValues = useMemo(
    () => (compare ? series.prev.map((b) => b.total) : []),
    [series.prev, compare],
  );

  const monthLabels = useMemo(
    () => series.current.map((b) => bucketLabel(b.ym)),
    [series.current],
  );

  const annotationsQuery = useChartAnnotations({ projectId, limit: 100 });
  const annotationPins = useMemo(() => {
    if (series.current.length === 0) return [];
    const ymToIdx = new Map(series.current.map((b, i) => [b.ym, i]));
    return (annotationsQuery.data?.annotations ?? [])
      .map((a) => {
        const d = new Date(a.occurredAt);
        const ym = `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1)
          .toString()
          .padStart(2, "0")}`;
        const idx = ymToIdx.get(ym);
        if (idx === undefined) return null;
        return {
          id: a.id,
          idx,
          label: a.label,
          color: a.color ?? "var(--color-rv-accent-500)",
        };
      })
      .filter((a): a is { id: string; idx: number; label: string; color: string } => a !== null);
  }, [annotationsQuery.data, series.current]);

  const error = currentQuery.error ?? (compare ? prevQuery.error : null);
  const isLoading = currentQuery.isLoading || (compare && prevQuery.isLoading);

  const all = [...currentValues, ...prevValues];
  const yMax = Math.max(...all, 1) * 1.08;

  const x = (i: number) =>
    PAD_L + (i / Math.max(monthLabels.length - 1, 1)) * INNER_W;
  const y = (v: number) => PAD_T + (1 - v / yMax) * INNER_H;
  const pathFor = (arr: ReadonlyArray<number>) =>
    arr
      .map(
        (v, i) =>
          `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`,
      )
      .join(" ");
  const areaFor = (arr: ReadonlyArray<number>) =>
    `${pathFor(arr)} L ${x(arr.length - 1)},${PAD_T + INNER_H} L ${PAD_L},${
      PAD_T + INNER_H
    } Z`;

  const cur = currentValues[currentValues.length - 1] ?? 0;
  const prevVal = currentValues[currentValues.length - 2] ?? cur;
  const delta = prevVal === 0 ? 0 : ((cur - prevVal) / prevVal) * 100;
  const deltaUp = delta >= 0;

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <header className="mb-3.5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
            {t("charts.mrr.headLabel")}
          </div>
          <div className="mt-1 font-rv-mono text-[28px] font-medium tabular-nums">
            {isLoading && !currentQuery.data
              ? "—"
              : formatCurrencyCompact(cur)}
          </div>
          <div
            className={cn(
              "mt-1 flex items-center gap-1.5 font-rv-mono text-[12px]",
              deltaUp ? "text-rv-success" : "text-rv-danger",
            )}
          >
            {deltaUp ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
            {Math.abs(delta).toFixed(1)}%{" "}
            {t("charts.mrr.momDelta", {
              value: formatCurrencyCompact(cur - prevVal),
            })}
          </div>
        </div>
        <div className="flex flex-wrap gap-3.5 font-rv-mono text-[11px] text-rv-mute-600">
          <Legend
            color="var(--color-rv-accent-500)"
            label={t("charts.mrr.legendCurrent")}
          />
          <Legend
            color="var(--color-rv-success)"
            label={t("charts.mrr.legendNet", "Net")}
          />
          {compare && (
            <Legend
              color="var(--color-rv-mute-500)"
              label={t("charts.mrr.legendPrev")}
            />
          )}
          <Legend
            color="var(--color-rv-success)"
            label={t("charts.mrr.legendAnnotations")}
            round
          />
        </div>
      </header>

      {error && (
        <div className="mb-3 rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[11px] text-rv-danger">
          {t("charts.mrr.error", "Couldn't load MRR — using sample series.")}
        </div>
      )}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-[360px] w-full"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(
            ((px - PAD_L) / INNER_W) * (monthLabels.length - 1),
          );
          if (i >= 0 && i < monthLabels.length) setHoveredIdx(i);
          else setHoveredIdx(null);
        }}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        <defs>
          <linearGradient id="mrrAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor="var(--color-rv-accent-500)"
              stopOpacity="0.32"
            />
            <stop
              offset="100%"
              stopColor="var(--color-rv-accent-500)"
              stopOpacity="0"
            />
          </linearGradient>
        </defs>

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
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
          const v = (1 - tick) * yMax;
          return (
            <text
              key={tick}
              x={PAD_L - 10}
              y={PAD_T + tick * INNER_H + 3}
              fontSize="10"
              fill="var(--color-rv-mute-500)"
              textAnchor="end"
              fontFamily="var(--font-rv-mono)"
            >
              {formatCurrencyCompact(Math.round(v))}
            </text>
          );
        })}
        {monthLabels.map((m, i) => (
          <text
            key={`${m}-${i}`}
            x={x(i)}
            y={H - 16}
            fontSize="10"
            fill="var(--color-rv-mute-500)"
            textAnchor="middle"
            fontFamily="var(--font-rv-mono)"
          >
            {m}
          </text>
        ))}

        {annotationPins.map((a) => (
          <line
            key={`anno-${a.id}`}
            x1={x(a.idx)}
            x2={x(a.idx)}
            y1={PAD_T}
            y2={PAD_T + INNER_H}
            stroke={a.color}
            strokeOpacity="0.35"
            strokeDasharray="2 3"
          />
        ))}

        {chartType === "bar" ? (
          <>
            {compare &&
              prevValues.map((v, i) => {
                const bw = (INNER_W / monthLabels.length) * 0.35;
                return (
                  <rect
                    key={`prev-${i}`}
                    x={x(i) - bw - 1}
                    y={y(v)}
                    width={bw}
                    height={PAD_T + INNER_H - y(v)}
                    fill="var(--color-rv-mute-500)"
                    opacity={0.5}
                    rx={2}
                  />
                );
              })}
            {currentValues.map((v, i) => {
              const bw = (INNER_W / monthLabels.length) * 0.35;
              return (
                <rect
                  key={`cur-${i}`}
                  x={x(i) + 1}
                  y={y(v)}
                  width={bw}
                  height={PAD_T + INNER_H - y(v)}
                  fill="var(--color-rv-accent-500)"
                  rx={2}
                />
              );
            })}
          </>
        ) : (
          <>
            {chartType === "area" && (
              <path d={areaFor(currentValues)} fill="url(#mrrAreaGrad)" />
            )}
            {compare && prevValues.length > 0 && (
              <path
                d={pathFor(prevValues)}
                fill="none"
                stroke="var(--color-rv-mute-500)"
                strokeWidth="1.5"
                strokeDasharray="4 4"
              />
            )}
            <path
              d={pathFor(netValues)}
              fill="none"
              stroke="var(--color-rv-success)"
              strokeWidth="1.75"
              strokeDasharray="5 3"
            />
            <path
              d={pathFor(currentValues)}
              fill="none"
              stroke="var(--color-rv-accent-500)"
              strokeWidth="2.5"
            />
            {currentValues.map((v, i) => (
              <circle
                key={`pt-${i}`}
                cx={x(i)}
                cy={y(v)}
                r={i === monthLabels.length - 1 ? 4 : 2.5}
                fill="var(--color-rv-accent-500)"
                stroke="var(--color-rv-c1)"
                strokeWidth="1.5"
              />
            ))}
          </>
        )}

        {annotationPins.map((a) => (
          <circle key={`pin-${a.id}`} cx={x(a.idx)} cy={PAD_T - 6} r="4" fill={a.color} stroke="var(--color-rv-c1)" strokeWidth="2">
            <title>{a.label}</title>
          </circle>
        ))}

        {hoveredIdx !== null && hoveredIdx < currentValues.length && (
          <g>
            <line
              x1={x(hoveredIdx)}
              x2={x(hoveredIdx)}
              y1={PAD_T}
              y2={PAD_T + INNER_H}
              stroke="var(--color-rv-mute-700)"
              strokeOpacity="0.4"
            />
            <circle
              cx={x(hoveredIdx)}
              cy={y(currentValues[hoveredIdx]!)}
              r="5"
              fill="var(--color-rv-accent-500)"
              stroke="#fff"
              strokeWidth="2"
            />
            <g
              transform={`translate(${Math.min(
                W - 180,
                Math.max(PAD_L, x(hoveredIdx) + 12),
              )}, ${y(currentValues[hoveredIdx]!) - 50})`}
            >
              <rect
                width="160"
                height="58"
                rx="5"
                fill="var(--color-rv-c4)"
                stroke="var(--color-rv-divider-strong)"
              />
              <text
                x="10"
                y="16"
                fontSize="10"
                fill="var(--color-rv-mute-500)"
                fontFamily="var(--font-rv-mono)"
              >
                {monthLabels[hoveredIdx]}{" "}
                {series.current[hoveredIdx]?.ym.slice(0, 4) ??
                  now.getUTCFullYear()}
              </text>
              <text
                x="10"
                y="32"
                fontSize="13"
                fill="var(--color-rv-mute-800)"
                fontWeight="600"
                fontFamily="var(--font-rv-mono)"
              >
                {formatCurrencyCompact(currentValues[hoveredIdx]!)}
              </text>
              {compare && prevValues[hoveredIdx] !== undefined && (
                <text
                  x="10"
                  y="48"
                  fontSize="10"
                  fill="var(--color-rv-mute-500)"
                  fontFamily="var(--font-rv-mono)"
                >
                  {t("charts.mrr.tooltipPrev", {
                    value: formatCurrencyCompact(prevValues[hoveredIdx]!),
                  })}
                </text>
              )}
            </g>
          </g>
        )}
      </svg>

      <Decomposition
        newUsd={decomposition.data?.newUsd}
        expansionUsd={decomposition.data?.expansionUsd}
        churnedUsd={decomposition.data?.churnedUsd}
        loading={decomposition.isLoading}
      />
    </section>
  );
}

function Legend({
  color,
  label,
  round,
}: {
  color: string;
  label: string;
  round?: boolean;
}) {
  return (
    <span className="inline-flex cursor-pointer items-center gap-1.5">
      <span
        className={cn(
          "inline-block size-2.5",
          round ? "rounded-full" : "rounded-sm",
        )}
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function Decomposition({
  newUsd,
  expansionUsd,
  churnedUsd,
  loading,
}: {
  newUsd?: string;
  expansionUsd?: string;
  churnedUsd?: string;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const fmt = (v?: string) =>
    loading || v == null ? "—" : formatCurrencyCompact(Number(v));
  const items = [
    { key: "newMrr", labelKey: "charts.decomposition.newMrr", value: fmt(newUsd) },
    { key: "expansion", labelKey: "charts.decomposition.expansion", value: fmt(expansionUsd) },
    { key: "contraction", labelKey: "charts.decomposition.contraction", value: "—" },
    {
      key: "churned",
      labelKey: "charts.decomposition.churned",
      value: loading || churnedUsd == null ? "—" : `−${formatCurrencyCompact(Number(churnedUsd))}`,
    },
  ];

  return (
    <div className="mt-3.5 grid grid-cols-2 gap-3 border-t border-rv-divider pt-3.5 md:grid-cols-4">
      {items.map((item) => (
        <div key={item.key}>
          <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t(item.labelKey)}
          </div>
          <div className="mt-1 font-rv-mono text-[16px] font-medium tabular-nums text-rv-mute-700">
            {item.value}
          </div>
          <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">—</div>
        </div>
      ))}
    </div>
  );
}
