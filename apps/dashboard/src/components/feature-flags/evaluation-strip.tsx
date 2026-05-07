import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { evalSparkSeries } from "./format";

type Props = {
  evalRate: number;
  evals24h: number;
  killed?: boolean;
  /** Used to draw the sparkline; pass the flag's index or a hash. */
  seed: number;
};

const W = 360;
const H = 40;

/**
 * Eval-rate hero block — large per-second number, total 24h count, and a
 * filled sparkline showing recent traffic. Sits above targeting rules in
 * the flag detail panel.
 */
export function EvaluationStrip({ evalRate, evals24h, killed, seed }: Props) {
  const { t } = useTranslation();
  const path = useMemo(() => {
    const points = evalSparkSeries(seed);
    return points
      .map((p, i) => {
        const x = (i / (points.length - 1)) * W;
        const y = (1 - p) * H + 2;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [seed]);

  const stroke = killed
    ? "var(--color-rv-danger)"
    : "var(--color-rv-accent-500)";
  const fill = killed
    ? "var(--color-rv-danger)"
    : "var(--color-rv-accent-500)";

  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-md border border-rv-divider bg-rv-c2 p-3">
      <div>
        <div className="font-rv-mono text-[18px] font-medium tabular-nums">
          {t("featureFlags.eval.reqPerSec", { value: evalRate.toFixed(1) })}
        </div>
        <div className="mt-0.5 font-rv-mono text-[10px] text-rv-mute-500">
          {t("featureFlags.eval.summary", {
            count: evals24h.toLocaleString(),
          })}
        </div>
      </div>
      <svg
        width={W}
        height={44}
        viewBox={`0 0 ${W} 44`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <line
            key={g}
            x1={0}
            x2={W}
            y1={g * 40 + 2}
            y2={g * 40 + 2}
            stroke="var(--color-rv-divider)"
            strokeDasharray="3 3"
          />
        ))}
        <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} />
        <path d={`${path} L ${W} 44 L 0 44 Z`} fill={fill} opacity={0.12} />
      </svg>
    </div>
  );
}
