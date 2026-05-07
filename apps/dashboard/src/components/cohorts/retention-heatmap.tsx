import { Fragment, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { Button } from "../../ui/button";
import {
  formatActiveCount,
  formatMetricCellValue,
  metricSuffix,
  metricValue,
  retentionCellBackground,
  retentionCellText,
} from "./format";
import { COHORT_COLUMN_HEADERS, COHORT_ROWS } from "./mock-data";
import { MetricTabs } from "./metric-tabs";
import type { RetentionMetric } from "./types";

const HEATMAP_LEGEND_STOPS = [10, 25, 40, 55, 70, 85, 100] as const;

type HoveredCell = {
  cohort: string;
  week: number;
  baseValue: number;
  displayed: number;
  size: number;
};

type Props = {
  cohortName: string;
  metric: RetentionMetric;
  onMetricChange: (next: RetentionMetric) => void;
};

export function RetentionHeatmap({ cohortName, metric, onMetricChange }: Props) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<HoveredCell | null>(null);

  const headingKey =
    metric === "retention"
      ? "cohorts.retention.headingRetention"
      : metric === "revenue"
        ? "cohorts.retention.headingRevenue"
        : "cohorts.retention.headingCount";

  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-center justify-between gap-2.5 border-b border-rv-divider px-4 py-3.5">
        <div>
          <h3 className="text-[14px] font-semibold">{t(headingKey)}</h3>
          <p className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">
            {t("cohorts.retention.subtitle", { cohort: cohortName })}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <MetricTabs value={metric} onChange={onMetricChange} />
          <Button variant="flat" size="sm" className="h-7">
            <Download size={12} />
            {t("cohorts.actions.csv")}
          </Button>
        </div>
      </header>

      <div className="overflow-x-auto px-4 py-3.5">
        <div
          className="grid min-w-[900px] gap-0.5 font-rv-mono text-[11px]"
          style={{ gridTemplateColumns: "120px repeat(12, minmax(0, 1fr))" }}
        >
          <div className="px-1 py-1 text-center text-[10px] font-medium uppercase tracking-wide text-rv-mute-500">
            {t("cohorts.retention.cohortHeader")}
          </div>
          {COHORT_COLUMN_HEADERS.map((h) => (
            <div
              key={h}
              className="px-1 py-1 text-center text-[10px] font-medium uppercase tracking-wide text-rv-mute-500"
            >
              {h}
            </div>
          ))}

          {COHORT_ROWS.map((row, rIdx) => (
            <Fragment key={row.label}>
              <div className="py-1.5 pr-2.5 text-left font-medium text-rv-mute-700">
                {row.label}
                <span className="ml-1.5 text-[10px] text-rv-mute-500">
                  {row.size.toLocaleString()}
                </span>
              </div>
              {row.data.map((_raw, cIdx) => {
                const v = metricValue(row, cIdx, metric);
                const base = row.data[cIdx];
                const isData = v != null && base != null;
                return (
                  <button
                    key={cIdx}
                    type="button"
                    disabled={!isData}
                    onMouseEnter={() => {
                      if (isData) {
                        setHovered({
                          cohort: row.label,
                          week: cIdx,
                          baseValue: base,
                          displayed: v,
                          size: row.size,
                        });
                      }
                    }}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => {
                      if (isData) {
                        setHovered({
                          cohort: row.label,
                          week: cIdx,
                          baseValue: base,
                          displayed: v,
                          size: row.size,
                        });
                      }
                    }}
                    onBlur={() => setHovered(null)}
                    className={
                      "rounded-[3px] py-1.5 px-1 text-center tabular-nums transition " +
                      (isData
                        ? "cursor-pointer hover:scale-[1.08] hover:relative hover:z-10 hover:outline hover:outline-rv-accent-500"
                        : "cursor-default")
                    }
                    style={{
                      background: retentionCellBackground(base),
                      color: retentionCellText(base),
                    }}
                    title={
                      isData
                        ? `${row.label} · W${cIdx}: ${
                            metric === "count" ? v.toLocaleString() : v + metricSuffix(metric)
                          }`
                        : ""
                    }
                    data-row={rIdx}
                  >
                    {formatMetricCellValue(v, metric)}
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>

        <div className="mt-3.5 flex items-center gap-2.5 font-rv-mono text-[11px] text-rv-mute-500">
          <span>0{metricSuffix(metric)}</span>
          <div className="flex gap-0.5">
            {HEATMAP_LEGEND_STOPS.map((v) => (
              <div
                key={v}
                className="h-2.5 w-5 rounded-[2px]"
                style={{ background: retentionCellBackground(v) }}
              />
            ))}
          </div>
          <span>100{metricSuffix(metric)}</span>
          {hovered && (
            <span className="ml-auto text-foreground">
              <Trans
                i18nKey="cohorts.retention.hover"
                values={{
                  cohort: hovered.cohort,
                  week: hovered.week,
                  value:
                    metric === "count"
                      ? t("cohorts.retention.hoverActive", {
                          count: hovered.displayed.toLocaleString(),
                        })
                      : hovered.displayed + metricSuffix(metric),
                  active: Math.round(
                    (hovered.baseValue / 100) * hovered.size,
                  ).toLocaleString(),
                  size: hovered.size.toLocaleString(),
                }}
                components={[<strong key="0" />]}
              />
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

// Re-export so consumers don't need a deep import for the helper.
export { formatActiveCount };
