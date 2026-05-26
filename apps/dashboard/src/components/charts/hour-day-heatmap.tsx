import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChartHeatmap } from "../../lib/hooks/useProjectCharts";
import { heatColor } from "./format";
import { HEATMAP_DAY_KEYS } from "./mock-data";

const HOUR_TICKS = [0, 4, 8, 12, 16, 20] as const;
const LEGEND_STOPS = [0.1, 0.3, 0.5, 0.7, 0.9] as const;
const DAY_KEYS_MON_FIRST = HEATMAP_DAY_KEYS;
const DEFAULT_WINDOW_DAYS = 28;

// The API delivers cells keyed by `(dow, hour)` with Sunday=0..Saturday=6.
// The grid renders Mon→Sun. The helper builds a 7×24 grid of
// normalised intensities (0..1) plus the underlying raw counts so
// the tooltip can show "Sat 19:00 — 218 events".

interface PivotResult {
  matrix: number[][];
  counts: number[][];
  peak: { dow: number; hour: number; count: number } | null;
}

function pivot(cells: ReadonlyArray<{ dow: number; hour: number; count: number }>): PivotResult {
  const counts: number[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0),
  );
  let max = 0;
  let peak: PivotResult["peak"] = null;
  for (const c of cells) {
    // Wire convention: Sun=0..Sat=6. Grid convention: Mon=0..Sun=6.
    const row = c.dow === 0 ? 6 : c.dow - 1;
    if (row < 0 || row > 6 || c.hour < 0 || c.hour > 23) continue;
    counts[row]![c.hour] = c.count;
    if (c.count > max) {
      max = c.count;
      peak = c;
    }
  }
  const matrix = counts.map((row) =>
    row.map((c) => (max > 0 ? c / max : 0)),
  );
  return { matrix, counts, peak };
}

type Props = {
  projectId: string;
};

export function HourDayHeatmap({ projectId }: Props) {
  const { t } = useTranslation();
  const { data } = useChartHeatmap({
    projectId,
    windowDays: DEFAULT_WINDOW_DAYS,
  });

  const { matrix, counts, peak } = useMemo(
    () => pivot(data?.cells ?? []),
    [data],
  );

  const peakLabel = useMemo(() => {
    if (!peak) return t("charts.heatmap.peak");
    const day = t(DAY_KEYS_MON_FIRST[(peak.dow === 0 ? 6 : peak.dow - 1)]!);
    const hh = peak.hour.toString().padStart(2, "0");
    return t("charts.heatmap.peakLive", {
      day,
      hour: `${hh}:00`,
      count: peak.count,
      defaultValue: `Peak: {{day}} {{hour}} UTC · {{count}} events/h`,
    });
  }, [peak, t]);

  return (
    <div className="col-span-full rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <h4 className="mb-3 flex items-baseline justify-between gap-2.5 truncate text-[13px] font-semibold">
        <span className="truncate">{t("charts.heatmap.title")}</span>
        <span className="shrink-0 font-rv-mono text-[11px] font-normal text-rv-mute-500">
          {t("charts.heatmap.subtitle", {
            days: data?.windowDays ?? DEFAULT_WINDOW_DAYS,
          })}
        </span>
      </h4>

      <div>
        {DAY_KEYS_MON_FIRST.map((dayKey, i) => (
          <div key={dayKey} className="flex items-center">
            <div className="w-10 shrink-0 pr-1.5 text-right font-rv-mono text-[9px] leading-[18px] text-rv-mute-500">
              {t(dayKey)}
            </div>
            <div className="mb-0.5 flex flex-1 gap-0.5">
              {matrix[i]!.map((v, j) => (
                <div
                  key={j}
                  className="h-[18px] flex-1 rounded-[2px]"
                  style={{ background: heatColor(v) }}
                  title={`${t(dayKey)} ${j}:00 — ${counts[i]![j]}`}
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
        <span>{peakLabel}</span>
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
