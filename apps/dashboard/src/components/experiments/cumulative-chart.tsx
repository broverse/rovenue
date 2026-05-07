import { useTranslation } from "react-i18next";
import type { CumulativePoint } from "./types";

type Props = {
  points: ReadonlyArray<CumulativePoint>;
  metricNameKey: string;
};

const CHART_W = 760;
const CHART_H = 220;
const PAD_L = 40;
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 28;

const SERIES = [
  { key: "ctrl", color: "var(--color-rv-mute-500)" },
  { key: "a", color: "var(--color-rv-accent-500)" },
  { key: "b", color: "var(--color-rv-violet)" },
] as const;

/**
 * Cumulative metric chart — three line series over a 12-day window,
 * mono axis labels, dashed gridlines. The series ordering keeps
 * variant_b on top so it sits above control when curves cross.
 */
export function CumulativeChart({ points, metricNameKey }: Props) {
  const { t } = useTranslation();
  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;
  const all = points.flatMap((p) => [p.ctrl, p.a, p.b]);
  const yMin = Math.min(...all) * 0.98;
  const yMax = Math.max(...all) * 1.02;
  const x = (i: number) => PAD_L + (i / (points.length - 1)) * innerW;
  const y = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * innerH;
  const path = (key: "ctrl" | "a" | "b") =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`)
      .join(" ");
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const xTicks = [0, 3, 6, 9, 12];
  const last = points[points.length - 1]!;
  const metricLower = t(metricNameKey).toLowerCase();

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <header className="mb-3.5 flex items-start justify-between">
        <div>
          <h3 className="m-0 text-[14px] font-semibold">
            {t("experiments.cumulative.title", { metric: metricLower })}
          </h3>
          <p className="mt-0.5 text-[11px] text-rv-mute-500">
            {t("experiments.cumulative.subtitle")}
          </p>
        </div>
        <div className="flex gap-3.5 text-[11px] text-rv-mute-600">
          {SERIES.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 font-rv-mono">
              <span className="size-2 rounded-[2px]" style={{ background: s.color }} />
              {s.key === "ctrl" ? "control" : s.key === "a" ? "variant_a" : "variant_b"}
            </span>
          ))}
        </div>
      </header>
      <svg
        className="block h-[220px] w-full"
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t("experiments.cumulative.title", { metric: metricLower })}
      >
        {yTicks.map((g) => {
          const gy = PAD_T + g * innerH;
          return (
            <line
              key={g}
              x1={PAD_L}
              x2={CHART_W - PAD_R}
              y1={gy}
              y2={gy}
              stroke="var(--color-rv-divider)"
              strokeDasharray="3 3"
            />
          );
        })}
        {yTicks.map((tick) => {
          const v = yMin + (1 - tick) * (yMax - yMin);
          return (
            <text
              key={tick}
              x={PAD_L - 6}
              y={PAD_T + tick * innerH + 3}
              fontSize="9"
              fill="var(--color-rv-mute-500)"
              textAnchor="end"
              fontFamily="var(--font-rv-mono)"
            >
              {(v * 100).toFixed(1)}%
            </text>
          );
        })}
        {xTicks.map((tick) => (
          <text
            key={tick}
            x={x(tick)}
            y={CHART_H - 10}
            fontSize="9"
            fill="var(--color-rv-mute-500)"
            textAnchor="middle"
            fontFamily="var(--font-rv-mono)"
          >
            d{tick}
          </text>
        ))}
        <path d={path("ctrl")} fill="none" stroke={SERIES[0].color} strokeWidth="2" />
        <path d={path("a")} fill="none" stroke={SERIES[1].color} strokeWidth="2" />
        <path d={path("b")} fill="none" stroke={SERIES[2].color} strokeWidth="2" />
        {SERIES.map((s) => (
          <circle
            key={s.key}
            cx={x(points.length - 1)}
            cy={y(last[s.key])}
            r="3.5"
            fill={s.color}
            stroke="var(--color-rv-c1)"
            strokeWidth="2"
          />
        ))}
      </svg>
    </section>
  );
}
