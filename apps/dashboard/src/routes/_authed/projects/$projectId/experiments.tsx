import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, BookOpen, Plus } from "lucide-react";
import { Button } from "../../../../ui/button";
import { StatCard } from "../../../../ui/stat-card";
import {
  AllocationCard,
  CUMULATIVE_TREND,
  ConfigurationCard,
  ConversionFunnel,
  CumulativeChart,
  EXPERIMENTS_KPI,
  EXPERIMENT_DETAILS,
  ExperimentHero,
  ExperimentTimeline,
  ExperimentsList,
  VariantsTable,
  mapApiExperiment,
  type ExperimentScope,
  type ExperimentSummary,
} from "../../../../components/experiments";
import { useExperiments } from "../../../../lib/hooks/useExperiments";
import { useProject } from "../../../../lib/hooks/useProject";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/experiments",
)({
  component: ExperimentsRouteComponent,
});

function ExperimentsRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/experiments",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <ExperimentsPage projectId={projectId} />;
}

// Mock keys are still used as the detail fallback while the funnel,
// timeline, and cumulative-trend rollups land in Phase 3 (see
// docs/superpowers/plans/2026-05-09-dashboard-api-wiring-roadmap.md).
const DETAIL_FALLBACK_KEY = "paywall_v2_pricing";

function ExperimentsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: experiments = [] } = useExperiments({ projectId });

  const [scope, setScope] = useState<ExperimentScope>("running");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const summaries = useMemo<ReadonlyArray<ExperimentSummary>>(
    () => experiments.map(mapApiExperiment),
    [experiments],
  );

  const scoped = useMemo<ReadonlyArray<ExperimentSummary>>(() => {
    if (scope === "all") return summaries;
    return summaries.filter((e) => e.status === scope);
  }, [scope, summaries]);

  const scopeCounts = useMemo(
    () => ({
      running: summaries.filter((e) => e.status === "running").length,
      completed: summaries.filter((e) => e.status === "completed").length,
      draft: summaries.filter((e) => e.status === "draft").length,
      all: summaries.length,
    }),
    [summaries],
  );

  // When the list loads (or the scope filters everything out), default
  // the selection to the first visible row. Guards against stale ids
  // sticking around after lifecycle changes or scope swaps.
  useEffect(() => {
    if (scoped.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !scoped.some((e) => e.id === selectedId)) {
      setSelectedId(scoped[0]!.id);
    }
  }, [scoped, selectedId]);

  const selected = useMemo<ExperimentSummary | null>(() => {
    if (!selectedId) return null;
    return summaries.find((e) => e.id === selectedId) ?? null;
  }, [selectedId, summaries]);

  const detail =
    (selected && EXPERIMENT_DETAILS[selected.id]) ??
    EXPERIMENT_DETAILS[DETAIL_FALLBACK_KEY]!;

  return (
    <>
      <header className="flex items-start justify-between gap-4 pb-5">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("experiments.title")}
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">
            {t("experiments.subtitle")}
            <span className="ml-1 inline-block rounded-[3px] border border-rv-divider bg-rv-c4 px-1.5 py-px font-rv-mono text-[11px] text-rv-mute-700">
              hash(user_id)
            </span>
            {t("experiments.subtitleSuffix")}
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button variant="flat">
            <BookOpen size={13} />
            {t("experiments.actions.runbook")}
          </Button>
          <Button variant="flat">
            <ArrowDownToLine size={13} />
            {t("experiments.actions.importFromSdk")}
          </Button>
          <Button variant="solid-primary">
            <Plus size={13} />
            {t("experiments.actions.newExperiment")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("experiments.kpi.running")}
          value={scopeCounts.running.toLocaleString()}
          description={t("experiments.kpi.runningDescription", {
            withPower: EXPERIMENTS_KPI.runningPower,
            gathering: EXPERIMENTS_KPI.runningGathering,
          })}
        />
        <StatCard
          label={t("experiments.kpi.usersAssigned")}
          value={EXPERIMENTS_KPI.usersAssigned.toLocaleString()}
          description={t("experiments.kpi.usersAssignedDescription", {
            share: EXPERIMENTS_KPI.usersAssignedShare,
          })}
        />
        <StatCard
          label={t("experiments.kpi.shippedWins")}
          value={
            <span className="text-rv-success">
              {scopeCounts.completed}
            </span>
          }
          description={t("experiments.kpi.shippedWinsDescription", {
            impact: EXPERIMENTS_KPI.shippedMrrImpact,
          })}
          descriptionTone="success"
        />
        <StatCard
          label={t("experiments.kpi.timeToDecision")}
          value={`${EXPERIMENTS_KPI.decisionDays}d`}
          description={t("experiments.kpi.timeToDecisionDescription", {
            target: EXPERIMENTS_KPI.decisionTarget,
          })}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <ExperimentsList
          experiments={scoped}
          scope={scope}
          onScopeChange={setScope}
          selectedId={selected?.id ?? ""}
          onSelect={setSelectedId}
          scopeCounts={scopeCounts}
        />

        <div className="flex min-w-0 flex-col gap-4">
          {selected ? (
            <>
              <ExperimentHero experiment={selected} />
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
                <ConfigurationCard experiment={selected} detail={detail} />
              </div>
            </>
          ) : (
            <div className="flex h-[200px] items-center justify-center rounded-lg border border-rv-divider bg-rv-c1 text-[13px] text-rv-mute-500">
              {t("experiments.list.empty")}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
