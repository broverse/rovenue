import { useTranslation } from "react-i18next";
import { LTV_CURVES } from "./mock-data";
import type { LtvCurve } from "./types";

const W = 640;
const H = 220;
const PAD = { l: 36, r: 12, t: 12, b: 28 };
const MAX_USD = 22;

const COLOR_VAR: Record<LtvCurve["color"], string> = {
  primary: "var(--color-rv-accent-500)",
  violet: "var(--color-rv-violet)",
  success: "var(--color-rv-success)",
  warning: "var(--color-rv-warning)",
};

const x = (i: number) => PAD.l + (i / 11) * (W - PAD.l - PAD.r);
const y = (v: number) => PAD.t + (1 - v / MAX_USD) * (H - PAD.t - PAD.b);

export function LtvCurves() {
  const { t } = useTranslation();
  const yTicks = [0, 5, 10, 15, 20];
  const xTicks: ReadonlyArray<string> = ["W0", "W2", "W4", "W6", "W8", "W10"];

  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="border-b border-rv-divider px-4 py-3.5">
        <h3 className="text-[14px] font-semibold">{t("cohorts.ltv.title")}</h3>
        <p className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">
          {t("cohorts.ltv.subtitle")}
        </p>
      </header>

      <div className="px-4 py-3.5">
        <svg
          role="img"
          aria-label={t("cohorts.ltv.title")}
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--color-rv-divider)"
                strokeDasharray="3 3"
              />
              <text
                x={PAD.l - 6}
                y={y(v) + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--color-rv-mute-500)"
                fontFamily="var(--font-rv-mono)"
              >
                ${v}
              </text>
            </g>
          ))}

          {xTicks.map((label, idx) => (
            <text
              key={label}
              x={x(idx * 2)}
              y={H - 8}
              textAnchor="middle"
              fontSize="10"
              fill="var(--color-rv-mute-500)"
              fontFamily="var(--font-rv-mono)"
            >
              {label}
            </text>
          ))}

          {LTV_CURVES.map((curve) => {
            const stroke = COLOR_VAR[curve.color];
            const valid: Array<[number, number]> = [];
            curve.points.forEach((v, i) => {
              if (v != null) valid.push([x(i), y(v)]);
            });
            const path = valid
              .map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1))
              .join(" ");
            return (
              <g key={curve.label}>
                <path d={path} fill="none" stroke={stroke} strokeWidth={1.8} />
                {valid.map((p, i) => (
                  <circle key={i} cx={p[0]} cy={p[1]} r={2.5} fill={stroke} />
                ))}
              </g>
            );
          })}
        </svg>

        <div className="mt-2 flex flex-wrap gap-3">
          {LTV_CURVES.map((curve) => {
            const lastValid = [...curve.points].reverse().find((v) => v != null);
            return (
              <div
                key={curve.label}
                className="flex items-center gap-1.5 font-rv-mono text-[11px] text-rv-mute-600"
              >
                <span
                  aria-hidden
                  className="h-0.5 w-[18px] rounded-[1px]"
                  style={{ background: COLOR_VAR[curve.color] }}
                />
                {curve.label}
                <span className="ml-0.5 text-rv-mute-500">
                  {t("cohorts.ltv.toDate", { value: (lastValid ?? 0).toFixed(1) })}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
