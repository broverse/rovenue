import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ChartFunnelStep } from "@rovenue/shared";
import { useChartFunnel } from "../../lib/hooks/useProjectCharts";

const DEFAULT_WINDOW_DAYS = 28;

// The API returns four stable keys; map them to the existing i18n
// strings so designers can tweak copy without touching this file.
const STEP_LABEL_KEY: Record<ChartFunnelStep["key"], string> = {
  purchase: "charts.funnel.install",
  trial: "charts.funnel.trial",
  trial_to_paid: "charts.funnel.paid",
  renewal: "charts.funnel.renewal",
};

const FALLBACK_STEP_KEYS: ReadonlyArray<ChartFunnelStep["key"]> = [
  "purchase",
  "trial",
  "trial_to_paid",
  "renewal",
];

interface FunnelRow {
  id: string;
  label: string;
  value: number;
  pct: number;
}

type Props = {
  projectId: string;
};

export function FunnelCard({ projectId }: Props) {
  const { t } = useTranslation();
  const { data } = useChartFunnel({
    projectId,
    windowDays: DEFAULT_WINDOW_DAYS,
  });

  const rows: FunnelRow[] = useMemo(() => {
    const steps = data?.steps ?? [];
    if (steps.length === 0) {
      // Render the canonical four-step shell with zeros so the
      // panel keeps its shape on empty projects.
      return FALLBACK_STEP_KEYS.map((key) => ({
        id: key,
        label: t(STEP_LABEL_KEY[key], key),
        value: 0,
        pct: 0,
      }));
    }
    return steps.map((s) => ({
      id: s.key,
      label: t(STEP_LABEL_KEY[s.key], s.key),
      value: s.count,
      pct: s.pct,
    }));
  }, [data, t]);

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <h4 className="mb-3 flex items-baseline justify-between gap-2.5 truncate text-[13px] font-semibold">
        <span className="truncate">{t("charts.funnel.title")}</span>
        <span className="shrink-0 font-rv-mono text-[11px] font-normal text-rv-mute-500">
          {t("charts.funnel.subtitle", {
            days: data?.windowDays ?? DEFAULT_WINDOW_DAYS,
          })}
        </span>
      </h4>
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.id}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate text-rv-mute-700">
                {row.label}
              </span>
              <span className="shrink-0 font-rv-mono text-rv-mute-500 tabular-nums">
                {row.value.toLocaleString()}{" "}
                <span className="ml-1 text-rv-mute-400">{row.pct}%</span>
              </span>
            </div>
            <div className="h-3 overflow-hidden rounded-[3px] bg-rv-c2">
              <div
                className="h-full rounded-[3px]"
                style={{
                  width: `${row.pct}%`,
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
