import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { FunnelStage } from "./types";

type Props = {
  stages: ReadonlyArray<FunnelStage>;
};

const ROWS = [
  { key: "ctrl", label: "control", className: "bg-rv-mute-500/75" },
  { key: "a", label: "var_a", className: "bg-rv-accent-500" },
  { key: "b", label: "var_b", className: "bg-rv-violet" },
] as const;

/**
 * Three-arm funnel — one row per stage, with three stacked bars
 * (control / variant_a / variant_b) sized against the largest stage
 * value. Percent next to each value is computed against control so
 * the drop-off pattern reads at a glance.
 */
export function ConversionFunnel({ stages }: Props) {
  const { t } = useTranslation();
  const max = Math.max(...stages.flatMap((s) => [s.ctrl, s.a, s.b]));
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <h3 className="m-0 mb-3 text-[14px] font-semibold">
        {t("experiments.funnel.title")}
      </h3>
      {stages.map((stage) => (
        <div
          key={stage.stageKey}
          className="grid grid-cols-[140px_1fr] items-center gap-3.5 border-b border-white/[0.05] py-2.5 last:border-b-0"
        >
          <div className="text-[12px] text-rv-mute-600">
            {t(stage.stageKey)}
            <div className="mt-0.5 font-rv-mono text-[10px] text-rv-mute-500">
              {t(stage.subKey)}
            </div>
          </div>
          <div className="space-y-1">
            {ROWS.map((row) => {
              const val = stage[row.key];
              return (
                <div key={row.key} className="flex items-center gap-2.5">
                  <div className="w-[52px] font-rv-mono text-[10px] text-rv-mute-500">
                    {row.label}
                  </div>
                  <div className="relative h-3.5 flex-1 overflow-hidden rounded-[3px] bg-rv-c2">
                    <div
                      className={cn("h-full rounded-[3px] transition-[width] duration-300", row.className)}
                      style={{ width: `${(val / max) * 100}%` }}
                    />
                  </div>
                  <div className="min-w-[80px] text-right font-rv-mono text-[11px] tabular-nums">
                    {val.toLocaleString()}
                    <span className="ml-1 text-[10px] text-rv-mute-500">
                      {((val / stage.ctrl) * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
