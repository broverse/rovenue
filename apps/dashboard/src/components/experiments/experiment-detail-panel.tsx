import { useTranslation } from "react-i18next";
import { AlertCircle, LineChart } from "lucide-react";
import { EmptyStateCard, LoadingState } from "../dashboard";
import { useExperiment } from "../../lib/hooks/useExperiments";
import { useExperimentResults } from "../../lib/hooks/useExperimentResults";
import { AllocationCard } from "./allocation-card";
import { ConversionFunnel } from "./conversion-funnel";
import { ExperimentAnalysisCard } from "./experiment-analysis-card";
import { ExperimentHero } from "./experiment-hero";
import { VariantsTable } from "./variants-table";
import {
  buildFunnelStages,
  hasLiveResultsData,
  isPaywallExperimentGroup,
  mapResultsVariants,
} from "./format";
import type { AllocationSlice, ExperimentSummary, VariantColorToken } from "./types";

type Props = {
  experiment: ExperimentSummary;
  projectId: string;
  /** Forwarded to the hero — shows the "View details" link on the inline panel. */
  showDetailsLink?: boolean;
};

const ALLOCATION_COLOR_CYCLE: ReadonlyArray<VariantColorToken> = [
  "default",
  "primary",
  "violet",
];

/**
 * The full experiment rollup: hero + live results from
 * `GET /dashboard/experiments/:id/results` (ClickHouse-backed, same
 * source the SDK reads). Shared by the inline experiments-list panel
 * and the focused `/experiments/$experimentId` detail route.
 *
 * Two independent queries feed this: `useExperiment` for the
 * experiment's own config (variant weights, for the allocation pie —
 * this is not results data, so it renders regardless of whether any
 * exposures have landed yet), and `useExperimentResults` for the live
 * analytics (variants/conversion/srm/sampleSize) — the only queries
 * gated behind a loading/error/no-data state below.
 */
export function ExperimentDetailPanel({
  experiment,
  projectId,
  showDetailsLink = false,
}: Props) {
  const { t } = useTranslation();
  const showAttributed = isPaywallExperimentGroup(experiment.group);

  const { data: experimentData } = useExperiment(experiment.id);
  const {
    data: results,
    isPending: resultsPending,
    isError: resultsErrored,
  } = useExperimentResults(projectId, experiment.id);

  const variantRows = mapResultsVariants(results, showAttributed);
  const hasData = hasLiveResultsData(results);
  const funnelStages = buildFunnelStages(variantRows, showAttributed);

  const allocationSlices: ReadonlyArray<AllocationSlice> | null =
    experimentData?.experiment.variants.map((v, i) => ({
      id: v.id,
      allocation: v.weight,
      colorToken: ALLOCATION_COLOR_CYCLE[i % ALLOCATION_COLOR_CYCLE.length]!,
    })) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ExperimentHero
        experiment={experiment}
        projectId={projectId}
        showDetailsLink={showDetailsLink}
      />

      {resultsPending ? (
        <LoadingState />
      ) : resultsErrored ? (
        <div className="flex items-start gap-2 rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
          <span>{t("experiments.detail.resultsError")}</span>
        </div>
      ) : hasData ? (
        <>
          <VariantsTable variants={variantRows} showAttributed={showAttributed} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ConversionFunnel stages={funnelStages} />
            {/* The results payload carries no time series, so there is
                no live source for a cumulative-trend chart — an honest
                "not available yet" card rather than the old mock line
                chart. */}
            <EmptyStateCard
              icon={LineChart}
              title={t("experiments.detail.cumulativeUnavailableTitle")}
              description={t("experiments.detail.cumulativeUnavailableDescription")}
            />
          </div>
        </>
      ) : (
        <EmptyStateCard
          icon={LineChart}
          large
          title={t("experiments.detail.noDataTitle")}
          description={t("experiments.detail.noDataDescription")}
        />
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {allocationSlices ? (
          <AllocationCard variants={allocationSlices} />
        ) : (
          <LoadingState />
        )}
        <ExperimentAnalysisCard experiment={experiment} results={results ?? null} />
      </div>
    </div>
  );
}
