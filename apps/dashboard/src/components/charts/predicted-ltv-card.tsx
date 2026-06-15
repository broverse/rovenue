import { useTranslation } from "react-i18next";
import { useProjectLtvPrediction } from "../../lib/hooks/useProjectLtvPrediction";
import { formatCurrencyCompact } from "./format";
import type { LtvSegment } from "@rovenue/shared";

type Props = { projectId: string };

function SegmentList({ title, segments }: { title: string; segments: LtvSegment[] }) {
  if (segments.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">{title}</div>
      <div className="space-y-1">
        {segments.slice(0, 6).map((s) => (
          <div key={s.key} className="flex items-center justify-between gap-2 font-rv-mono text-[11px]">
            <span className="truncate text-rv-mute-600">{s.label}</span>
            <span className="shrink-0 tabular-nums">
              {formatCurrencyCompact(Number(s.predictedLtvUsd))}
              <span className="ml-1 text-rv-mute-500">({s.size})</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PredictedLtvCard({ projectId }: Props) {
  const { t } = useTranslation();
  const { data, isLoading } = useProjectLtvPrediction(projectId);

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3.5 flex items-baseline justify-between">
        <div className="font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
          {t("charts.predictedLtv.title", { months: data?.horizonMonths ?? 12 })}
        </div>
      </div>

      <div className="font-rv-mono text-[28px] font-medium tabular-nums">
        {isLoading || !data ? "—" : formatCurrencyCompact(Number(data.blendedPredictedLtvUsd))}
      </div>

      {/* server-provided cold-start message; intentionally raw (not i18n) */}
      {data?.warning && (
        <div className="mt-2 rounded-md border border-rv-warning/30 bg-rv-warning/10 px-3 py-2 text-[11px] text-rv-warning">
          {data.warning}
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-4">
        <SegmentList title={t("charts.predictedLtv.byStore")} segments={data?.byStore ?? []} />
        <SegmentList title={t("charts.predictedLtv.byProduct")} segments={data?.byProduct ?? []} />
      </div>

      {data && data.cohorts.length > 0 && (
        <div className="mt-4 border-t border-rv-divider pt-3">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t("charts.predictedLtv.cohorts")}
          </div>
          <div className="space-y-1">
            {data.cohorts.slice(-6).map((c) => (
              <div key={c.cohortMonth} className="flex items-center justify-between gap-2 font-rv-mono text-[11px]">
                <span className="text-rv-mute-600">{c.cohortMonth.slice(0, 7)}</span>
                <span className="tabular-nums text-rv-mute-500">
                  {formatCurrencyCompact(Number(c.observedLtvUsd))} →{" "}
                  <span className="text-rv-mute-800">{formatCurrencyCompact(Number(c.predictedLtvUsd))}</span>
                  <span className="ml-1 text-rv-mute-500">{Math.round(c.maturity * 100)}%</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
