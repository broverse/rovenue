import { useState } from "react";

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  data: number[];
  negative?: boolean;
};

type Props = {
  series: ChartSeries[];
  categories: string[];
  height?: number;
  width?: number;
};

const PAD_L = 44;
const PAD_R = 16;
const PAD_T = 12;
const PAD_B = 28;

const fmtMoney = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`);

/**
 * Pure-SVG stacked area chart. Splits positive/negative series so churn
 * draws below a zero baseline. Hover shows a crosshair + tooltip.
 */
export function StackedAreaChart({ series, categories, height = 300, width = 760 }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const plotW = width - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;
  const n = categories.length;

  const totals = Array.from({ length: n }, (_, i) =>
    series.reduce((sum, s) => sum + Math.max(0, s.data[i] ?? 0) + Math.max(0, -(s.data[i] ?? 0)), 0),
  );
  const max = Math.max(...totals) * 1.1 || 1;

  const x = (i: number) => PAD_L + (i / (n - 1)) * plotW;
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;

  const positives = series.filter((s) => !s.negative);
  const negatives = series.filter((s) => s.negative);

  const stackPaths = (arr: ChartSeries[]) => {
    const cum = new Array(n).fill(0);
    return arr.map((s) => {
      const top = s.data.map((v, i) => cum[i] + Math.abs(v));
      const path =
        top.map((v, i) => (i === 0 ? `M${x(i)},${y(v)}` : `L${x(i)},${y(v)}`)).join(" ") +
        " " +
        cum.map((_, i) => `L${x(n - 1 - i)},${y(cum[n - 1 - i])}`).join(" ") +
        " Z";
      const line = top.map((v, i) => (i === 0 ? `M${x(i)},${y(v)}` : `L${x(i)},${y(v)}`)).join(" ");
      for (let i = 0; i < n; i++) cum[i] = top[i];
      return { path, line, color: s.color, key: s.key };
    });
  };

  const positiveStacks = stackPaths(positives);

  const zeroY = y(0);
  const negCum = new Array(n).fill(0);
  const negStacks = negatives.map((s) => {
    const abs = s.data.map((v) => Math.abs(v));
    const bottom = abs.map((v, i) => negCum[i] + v);
    const path =
      negCum.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${zeroY + (v / max) * plotH}`).join(" ") +
      " " +
      bottom.map((_, i) => {
        const idx = n - 1 - i;
        return `L${x(idx)},${zeroY + (bottom[idx] / max) * plotH}`;
      }).join(" ") +
      " Z";
    const line = bottom
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${zeroY + (v / max) * plotH}`)
      .join(" ");
    for (let i = 0; i < n; i++) negCum[i] = bottom[i];
    return { path, line, color: s.color, key: s.key };
  });

  const yTicks = 4;
  const tickVals = Array.from({ length: yTicks + 1 }, (_, i) => (max / yTicks) * i);
  const xTickIdx = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * width;
    const idx = Math.round(((mx - PAD_L) / plotW) * (n - 1));
    if (idx >= 0 && idx < n) setHover(idx);
  };

  return (
    <div className="relative w-full">
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block cursor-crosshair"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {tickVals.map((v, i) => (
          <g key={i}>
            <line x1={PAD_L} x2={width - PAD_R} y1={y(v)} y2={y(v)} stroke="var(--color-rv-divider)" strokeDasharray="3 3" />
            <text
              x={PAD_L - 8}
              y={y(v) + 3}
              fontSize="10"
              fill="var(--color-rv-mute-500)"
              textAnchor="end"
              fontFamily="Geist Mono"
            >
              {fmtMoney(v)}
            </text>
          </g>
        ))}
        {xTickIdx.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={height - 8}
            fontSize="10"
            fill="var(--color-rv-mute-500)"
            textAnchor="middle"
            fontFamily="Geist Mono"
          >
            {categories[i]}
          </text>
        ))}
        {positiveStacks.map((s) => (
          <g key={s.key}>
            <path d={s.path} fill={s.color} fillOpacity="0.18" />
            <path d={s.line} fill="none" stroke={s.color} strokeWidth="1.5" />
          </g>
        ))}
        {negStacks.map((s) => (
          <g key={s.key}>
            <path d={s.path} fill={s.color} fillOpacity="0.16" />
            <path d={s.line} fill="none" stroke={s.color} strokeWidth="1.5" strokeDasharray="4 3" />
          </g>
        ))}
        {negStacks.length > 0 && (
          <line x1={PAD_L} x2={width - PAD_R} y1={zeroY} y2={zeroY} stroke="var(--color-rv-divider-strong)" />
        )}
        {hover != null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              stroke="var(--color-rv-mute-500)"
              strokeDasharray="2 3"
            />
            {series.map((s) => (
              <circle
                key={s.key}
                cx={x(hover)}
                cy={y(Math.abs(s.data[hover] ?? 0))}
                r="3"
                fill={s.color}
                stroke="var(--color-rv-c1)"
                strokeWidth="2"
              />
            ))}
          </g>
        )}
      </svg>
      {hover != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-40 rounded-md border border-white/12 bg-[var(--color-rv-c3)] px-2.5 py-2 text-[11px] shadow-2xl"
          style={{
            left: `${(x(hover) / width) * 100}%`,
            transform: "translateX(8px)",
          }}
        >
          <div className="mb-1.5 font-rv-mono text-[11px] text-rv-mute-500">{categories[hover]}</div>
          {series.map((s) => (
            <div key={s.key} className="my-0.5 flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 text-rv-mute-700">
                <span className="size-2 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="font-rv-mono tabular-nums text-white">
                {s.negative ? "-" : ""}${Math.abs(s.data[hover] ?? 0).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
