import { useTranslation } from "react-i18next";
import { FUNNEL_STAGES } from "./mock-data";

export function FunnelCard() {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <h4 className="mb-3 flex items-baseline justify-between gap-2.5 truncate text-[13px] font-semibold">
        <span className="truncate">{t("charts.funnel.title")}</span>
        <span className="shrink-0 font-rv-mono text-[11px] font-normal text-rv-mute-500">
          {t("charts.funnel.subtitle")}
        </span>
      </h4>
      <div className="flex flex-col gap-2">
        {FUNNEL_STAGES.map((stage) => (
          <div key={stage.id}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate text-rv-mute-700">
                {t(stage.labelKey)}
              </span>
              <span className="shrink-0 font-rv-mono text-rv-mute-500 tabular-nums">
                {stage.value.toLocaleString()}{" "}
                <span className="ml-1 text-rv-mute-400">{stage.pct}%</span>
              </span>
            </div>
            <div className="h-3 overflow-hidden rounded-[3px] bg-rv-c2">
              <div
                className="h-full rounded-[3px]"
                style={{
                  width: `${stage.pct}%`,
                  background:
                    "linear-gradient(90deg, var(--color-rv-accent-600), var(--color-rv-accent-400))",
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
