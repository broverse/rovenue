import { useTranslation } from "react-i18next";
import { heatColor } from "./format";
import { HEATMAP_DAY_KEYS, HEATMAP_MATRIX } from "./mock-data";

const HOUR_TICKS = [0, 4, 8, 12, 16, 20] as const;
const LEGEND_STOPS = [0.1, 0.3, 0.5, 0.7, 0.9] as const;

export function HourDayHeatmap() {
  const { t } = useTranslation();

  return (
    <div className="col-span-full rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <h4 className="mb-3 flex items-baseline justify-between gap-2.5 truncate text-[13px] font-semibold">
        <span className="truncate">{t("charts.heatmap.title")}</span>
        <span className="shrink-0 font-rv-mono text-[11px] font-normal text-rv-mute-500">
          {t("charts.heatmap.subtitle")}
        </span>
      </h4>

      <div>
        {HEATMAP_DAY_KEYS.map((dayKey, i) => (
          <div key={dayKey} className="flex items-center">
            <div className="w-10 shrink-0 pr-1.5 text-right font-rv-mono text-[9px] leading-[18px] text-rv-mute-500">
              {t(dayKey)}
            </div>
            <div className="mb-0.5 flex flex-1 gap-0.5">
              {HEATMAP_MATRIX[i].map((v, j) => (
                <div
                  key={j}
                  className="h-[18px] flex-1 rounded-[2px]"
                  style={{ background: heatColor(v) }}
                  title={`${t(dayKey)} ${j}:00 — ${(v * 248).toFixed(0)}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-1.5 flex gap-0.5 pl-12 font-rv-mono text-[9px] text-rv-mute-500">
        {HOUR_TICKS.map((h) => (
          <span key={h} className="flex-1 text-center">
            {h}:00
          </span>
        ))}
      </div>

      <div className="mt-2.5 flex items-center justify-between font-rv-mono text-[10px] text-rv-mute-500">
        <span>{t("charts.heatmap.peak")}</span>
        <div className="flex items-center gap-1">
          <span>{t("charts.heatmap.low")}</span>
          {LEGEND_STOPS.map((v) => (
            <div
              key={v}
              className="h-2.5 w-3.5 rounded-[1px]"
              style={{ background: heatColor(v) }}
            />
          ))}
          <span>{t("charts.heatmap.high")}</span>
        </div>
      </div>
    </div>
  );
}
