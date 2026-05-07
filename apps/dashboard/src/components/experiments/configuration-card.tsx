import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ExperimentDetail, ExperimentSummary } from "./types";

type Props = {
  experiment: ExperimentSummary;
  detail: ExperimentDetail;
};

/**
 * Static key/value list — owner, segments, alpha, MDE, SRM check, etc.
 * Kept as a plain card so it renders fine even when the data shape
 * grows later (e.g. ramp schedule, holdout group).
 */
export function ConfigurationCard({ experiment, detail }: Props) {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <h3 className="m-0 mb-3 text-[14px] font-semibold">
        {t("experiments.configuration.title")}
      </h3>
      <Kv k={t("experiments.configuration.metric")} v={experiment.metric} />
      <Kv k={t("experiments.configuration.owner")} v={`@${detail.owner}`} />
      <Kv k={t("experiments.configuration.allocationKey")} v={detail.allocationKey} />
      <Kv k={t("experiments.configuration.segments")} v={detail.segments.join(", ")} />
      <Kv k={t("experiments.configuration.duration")} v="12 / 21 days" />
      <Kv k={t("experiments.configuration.alpha")} v="0.05" />
      <Kv k={t("experiments.configuration.mde")} v="±3.0%" />
      <Kv
        k={t("experiments.configuration.srm")}
        v={
          <span className="text-rv-success">
            {t("experiments.configuration.srmPassed")}
          </span>
        }
      />
    </section>
  );
}

function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-white/[0.04] py-1.5 text-[12px] last:border-b-0">
      <span className="text-rv-mute-500">{k}</span>
      <span className="font-rv-mono text-[11px] text-foreground">{v}</span>
    </div>
  );
}
