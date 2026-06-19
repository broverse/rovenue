import { useTranslation } from "react-i18next";
import { AllocationCard } from "./allocation-card";
import { ConfigurationCard } from "./configuration-card";
import { ConversionFunnel } from "./conversion-funnel";
import { CumulativeChart } from "./cumulative-chart";
import { ExperimentHero } from "./experiment-hero";
import { ExperimentTimeline } from "./experiment-timeline";
import { VariantsTable } from "./variants-table";
import { CUMULATIVE_TREND, EXPERIMENT_DETAILS } from "./mock-data";
import type { ExperimentSummary } from "./types";

type Props = {
  experiment: ExperimentSummary;
  projectId: string;
  /** Forwarded to the hero — shows the "View details" link on the inline panel. */
  showDetailsLink?: boolean;
};

/**
 * The full experiment rollup: hero + (when a seeded demo key matches) the
 * mock-driven variants/funnel/timeline cards, otherwise the Phase-3
 * analytics placeholder. Shared by the inline experiments-list panel and
 * the focused `/experiments/$experimentId` detail route.
 */
export function ExperimentDetailPanel({
  experiment,
  projectId,
  showDetailsLink = false,
}: Props) {
  const { t } = useTranslation();
  const detail = EXPERIMENT_DETAILS[experiment.key];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ExperimentHero
        experiment={experiment}
        projectId={projectId}
        showDetailsLink={showDetailsLink}
      />
      {detail ? (
        <>
          <VariantsTable
            variants={detail.variants}
            metricNameKey={detail.metricNameKey}
          />
          <CumulativeChart
            points={CUMULATIVE_TREND}
            metricNameKey={detail.metricNameKey}
          />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ConversionFunnel stages={detail.funnel} />
            <ExperimentTimeline entries={detail.timeline} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <AllocationCard variants={detail.variants} />
            <ConfigurationCard experiment={experiment} detail={detail} />
          </div>
        </>
      ) : (
        <div className="flex h-[180px] items-center justify-center rounded-lg border border-dashed border-rv-divider bg-rv-c1 px-6 text-center text-[12px] text-rv-mute-500">
          {t("experiments.detail.comingSoon")}
        </div>
      )}
    </div>
  );
}
