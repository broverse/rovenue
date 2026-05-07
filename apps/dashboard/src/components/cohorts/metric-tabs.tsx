import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { RetentionMetric } from "./types";

const OPTIONS: ReadonlyArray<RetentionMetric> = ["retention", "revenue", "count"];

type Props = {
  value: RetentionMetric;
  onChange: (next: RetentionMetric) => void;
};

const LABEL_KEYS: Record<RetentionMetric, string> = {
  retention: "cohorts.retention.metricRetention",
  revenue: "cohorts.retention.metricRevenue",
  count: "cohorts.retention.metricCount",
};

export function MetricTabs({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-[3px]"
    >
      {OPTIONS.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt)}
            className={cn(
              "h-7 cursor-pointer rounded px-3 text-[12px] transition",
              active
                ? "bg-rv-c4 text-foreground"
                : "text-rv-mute-600 hover:text-foreground",
            )}
          >
            {t(LABEL_KEYS[opt])}
          </button>
        );
      })}
    </div>
  );
}
