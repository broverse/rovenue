import { useTranslation } from "react-i18next";
import { variantColor, type FunnelSeriesStage } from "./format";

type Props = {
  stages: ReadonlyArray<FunnelSeriesStage>;
};

/**
 * Live funnel — one row per stage (exposures → exposed users →, when
 * gated, attributed conversions), one bar per variant sized against the
 * largest value across every stage so the drop-off reads at a glance.
 * Unlike the old mock version this is variant-count-agnostic (not
 * hardcoded to control/a/b) and only ever plots stages the results
 * payload actually has data for.
 */
export function ConversionFunnel({ stages }: Props) {
  const { t } = useTranslation();
  const max = Math.max(
    1,
    ...stages.flatMap((s) => s.values.map((v) => v.value)),
  );
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <h3 className="m-0 mb-3 text-[14px] font-semibold">
        {t("experiments.funnel.title")}
      </h3>
      {stages.map((stage) => {
        const baseline = stage.values[0]?.value ?? 0;
        return (
          <div
            key={stage.key}
            className="grid grid-cols-[140px_1fr] items-center gap-3.5 border-b border-white/[0.05] py-2.5 last:border-b-0"
          >
            <div className="text-[12px] text-rv-mute-600">
              {t(stage.labelKey)}
            </div>
            <div className="space-y-1">
              {stage.values.map((v) => (
                <div key={v.variantId} className="flex items-center gap-2.5">
                  <div className="w-[76px] truncate font-rv-mono text-[10px] text-rv-mute-500">
                    {v.variantId}
                  </div>
                  <div className="relative h-3.5 flex-1 overflow-hidden rounded-[3px] bg-rv-c2">
                    <div
                      className="h-full rounded-[3px] transition-[width] duration-300"
                      style={{
                        width: `${(v.value / max) * 100}%`,
                        background: variantColor(v.colorToken),
                      }}
                    />
                  </div>
                  <div className="min-w-[80px] text-right font-rv-mono text-[11px] tabular-nums">
                    {v.value.toLocaleString()}
                    {baseline > 0 && (
                      <span className="ml-1 text-[10px] text-rv-mute-500">
                        {((v.value / baseline) * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
