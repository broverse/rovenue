import { Fragment, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { CohortRetentionPoint } from "@rovenue/shared";
import { Button } from "../../ui/button";
import {
  formatActiveCount,
  formatMetricCellValue,
  metricSuffix,
  metricValue,
  retentionCellBackground,
  retentionCellText,
} from "./format";
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
  points: ReadonlyArray<CohortRetentionPoint>;
  size: number | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

export function RetentionHeatmap({
  cohortName,
  metric,
  onMetricChange,
  points,
  size,
  loading,
  error,
  onRetry,
}: Props) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<HoveredCell | null>(null);

  const headingKey =
    metric === "retention"
      ? "cohorts.retention.headingRetention"
      : metric === "revenue"
        ? "cohorts.retention.headingRevenue"
        : "cohorts.retention.headingCount";

  const columnHeaders = points.map((p) =>
    p.period === 0 ? t("cohorts.retention.activation") : `W${p.period}`,
  );

  const row = {
    cohort: cohortName,
    size: size ?? 0,
    cells: points.map((p) => ({ period: p.period, active: p.active, pct: p.pct })),
  };

  // Heatmap row shape compatible with metricValue helper
  const heatmapRow = {
    size: row.size,
    data: row.cells.map((c) => c.pct),
  };

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
        </div>
      </header>

      {error && (
        <div className="flex items-center justify-between border-b border-rv-divider bg-rv-c2 px-4 py-2.5 font-rv-mono text-[12px] text-rv-danger">
          <span>{error}</span>
          {onRetry && (
            <Button variant="flat" size="sm" className="h-6" onClick={onRetry}>
              {t("cohorts.retention.retry")}
            </Button>
          )}
        </div>
      )}

      <div className="overflow-x-auto px-4 py-3.5">
        {loading && points.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-rv-mute-500">
            {t("cohorts.retention.loading")}
          </div>
        ) : (
          <div
            className="grid min-w-[900px] gap-0.5 font-rv-mono text-[11px]"
            style={{
              gridTemplateColumns: `120px repeat(${columnHeaders.length}, minmax(0, 1fr))`,
            }}
          >
            <div className="px-1 py-1 text-center text-[10px] font-medium uppercase tracking-wide text-rv-mute-500">
              {t("cohorts.retention.cohortHeader")}
            </div>
            {columnHeaders.map((h) => (
              <div
                key={h}
                className="px-1 py-1 text-center text-[10px] font-medium uppercase tracking-wide text-rv-mute-500"
              >
                {h}
              </div>
            ))}

            <Fragment>
              <div className="py-1.5 pr-2.5 text-left font-medium text-rv-mute-700">
                {row.cohort}
                <span className="ml-1.5 text-[10px] text-rv-mute-500">
                  {row.size.toLocaleString()}
                </span>
              </div>
              {row.cells.map((_cell, cIdx) => {
                const v = metricValue(heatmapRow, cIdx, metric);
                const base = heatmapRow.data[cIdx];
                const isData = v != null && base != null;
                return (
                  <button
                    key={cIdx}
                    type="button"
                    disabled={!isData}
                    onMouseEnter={() => {
                      if (isData) {
                        setHovered({
                          cohort: row.cohort,
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
                          cohort: row.cohort,
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
                        ? `${row.cohort} · W${cIdx}: ${
                            metric === "count" ? v.toLocaleString() : v + metricSuffix(metric)
                          }`
                        : ""
                    }
                  >
                    {formatMetricCellValue(v, metric)}
                  </button>
                );
              })}
            </Fragment>
          </div>
        )}

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
