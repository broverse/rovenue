import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "../../lib/cn";
import { formatCurrencyCompact } from "./format";
import { ANNOTATIONS, CHART_MONTH_LABELS, MRR_SERIES } from "./mock-data";
import type { ChartType } from "./types";

const W = 800;
const H = 360;
const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 24;
const PAD_B = 38;
const INNER_W = W - PAD_L - PAD_R;
const INNER_H = H - PAD_T - PAD_B;

type Props = {
  chartType: ChartType;
  compare: boolean;
};

export function MrrChartPanel({ chartType, compare }: Props) {
  const { t } = useTranslation();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const months = CHART_MONTH_LABELS;
  const all = [...MRR_SERIES.current, ...(compare ? MRR_SERIES.prev : [])];
  const yMax = Math.max(...all) * 1.08;

  const x = (i: number) =>
    PAD_L + (i / (months.length - 1)) * INNER_W;
  const y = (v: number) => PAD_T + (1 - v / yMax) * INNER_H;
  const pathFor = (arr: ReadonlyArray<number>) =>
    arr
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(" ");
  const areaFor = (arr: ReadonlyArray<number>) =>
    `${pathFor(arr)} L ${x(arr.length - 1)},${PAD_T + INNER_H} L ${PAD_L},${
      PAD_T + INNER_H
    } Z`;

  const cur = MRR_SERIES.current[MRR_SERIES.current.length - 1];
  const prev = MRR_SERIES.current[MRR_SERIES.current.length - 2];
  const delta = ((cur - prev) / prev) * 100;
  const deltaUp = delta >= 0;

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <header className="mb-3.5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
            {t("charts.mrr.headLabel")}
          </div>
          <div className="mt-1 font-rv-mono text-[28px] font-medium tabular-nums">
            {formatCurrencyCompact(cur)}
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
              value: formatCurrencyCompact(cur - prev),
            })}
          </div>
        </div>
        <div className="flex flex-wrap gap-3.5 font-rv-mono text-[11px] text-rv-mute-600">
          <Legend
            color="var(--color-rv-accent-500)"
            label={t("charts.mrr.legendCurrent")}
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

      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-[360px] w-full"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((px - PAD_L) / INNER_W) * (months.length - 1));
          if (i >= 0 && i < months.length) setHoveredIdx(i);
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
        {months.map((m, i) => (
          <text
            key={m}
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

        {ANNOTATIONS.map((a, i) => (
          <line
            key={`anno-${i}`}
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
              MRR_SERIES.prev.map((v, i) => {
                const bw = (INNER_W / months.length) * 0.35;
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
            {MRR_SERIES.current.map((v, i) => {
              const bw = (INNER_W / months.length) * 0.35;
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
              <path d={areaFor(MRR_SERIES.current)} fill="url(#mrrAreaGrad)" />
            )}
            {compare && (
              <path
                d={pathFor(MRR_SERIES.prev)}
                fill="none"
                stroke="var(--color-rv-mute-500)"
                strokeWidth="1.5"
                strokeDasharray="4 4"
              />
            )}
            <path
              d={pathFor(MRR_SERIES.current)}
              fill="none"
              stroke="var(--color-rv-accent-500)"
              strokeWidth="2.5"
            />
            {MRR_SERIES.current.map((v, i) => (
              <circle
                key={`pt-${i}`}
                cx={x(i)}
                cy={y(v)}
                r={i === months.length - 1 ? 4 : 2.5}
                fill="var(--color-rv-accent-500)"
                stroke="var(--color-rv-c1)"
                strokeWidth="1.5"
              />
            ))}
          </>
        )}

        {ANNOTATIONS.map((a, i) => (
          <circle
            key={`pin-${i}`}
            cx={x(a.idx)}
            cy={PAD_T - 6}
            r="4"
            fill={a.color}
            stroke="var(--color-rv-c1)"
            strokeWidth="2"
          />
        ))}

        {hoveredIdx !== null && (
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
              cy={y(MRR_SERIES.current[hoveredIdx])}
              r="5"
              fill="var(--color-rv-accent-500)"
              stroke="#fff"
              strokeWidth="2"
            />
            <g
              transform={`translate(${Math.min(
                W - 180,
                Math.max(PAD_L, x(hoveredIdx) + 12),
              )}, ${y(MRR_SERIES.current[hoveredIdx]) - 50})`}
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
                {months[hoveredIdx]} 2025
              </text>
              <text
                x="10"
                y="32"
                fontSize="13"
                fill="var(--color-rv-mute-800)"
                fontWeight="600"
                fontFamily="var(--font-rv-mono)"
              >
                {formatCurrencyCompact(MRR_SERIES.current[hoveredIdx])}
              </text>
              {compare && (
                <text
                  x="10"
                  y="48"
                  fontSize="10"
                  fill="var(--color-rv-mute-500)"
                  fontFamily="var(--font-rv-mono)"
                >
                  {t("charts.mrr.tooltipPrev", {
                    value: formatCurrencyCompact(MRR_SERIES.prev[hoveredIdx]),
                  })}
                </text>
              )}
            </g>
          </g>
        )}
      </svg>

      <Decomposition />
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
        className={cn("inline-block size-2.5", round ? "rounded-full" : "rounded-sm")}
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function Decomposition() {
  const { t } = useTranslation();
  const lastIdx = MRR_SERIES.current.length - 1;
  const items = [
    {
      key: "newMrr",
      labelKey: "charts.decomposition.newMrr",
      value: `+${formatCurrencyCompact(MRR_SERIES.newMrr[lastIdx])}`,
      valueTone: "success" as const,
      delta: "+12.4%",
      deltaTone: "up" as const,
    },
    {
      key: "expansion",
      labelKey: "charts.decomposition.expansion",
      value: `+${formatCurrencyCompact(MRR_SERIES.expansion[lastIdx])}`,
      valueTone: "success" as const,
      delta: "+8.1%",
      deltaTone: "up" as const,
    },
    {
      key: "contraction",
      labelKey: "charts.decomposition.contraction",
      value: formatCurrencyCompact(MRR_SERIES.contraction[lastIdx]),
      valueTone: "muted" as const,
      delta: "+3.2%",
      deltaTone: "down" as const,
    },
    {
      key: "churned",
      labelKey: "charts.decomposition.churned",
      value: formatCurrencyCompact(MRR_SERIES.churn[lastIdx]),
      valueTone: "muted" as const,
      delta: "-2.1%",
      deltaTone: "up" as const,
    },
  ];

  return (
    <div className="mt-3.5 grid grid-cols-2 gap-3 border-t border-rv-divider pt-3.5 md:grid-cols-4">
      {items.map((item) => (
        <div key={item.key}>
          <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t(item.labelKey)}
          </div>
          <div
            className={cn(
              "mt-1 font-rv-mono text-[16px] font-medium tabular-nums",
              item.valueTone === "success" ? "text-rv-success" : "text-rv-mute-700",
            )}
          >
            {item.value}
          </div>
          <div
            className={cn(
              "mt-0.5 flex items-center gap-1 font-rv-mono text-[11px]",
              item.deltaTone === "up" ? "text-rv-success" : "text-rv-danger",
            )}
          >
            {item.deltaTone === "up" ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
            {item.delta}
          </div>
        </div>
      ))}
    </div>
  );
}
