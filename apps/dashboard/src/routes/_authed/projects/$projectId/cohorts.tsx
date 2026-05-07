import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BookOpen, Download, Plus } from "lucide-react";
import { Button } from "../../../../ui/button";
import { StatCard } from "../../../../ui/stat-card";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  CohortBuilder,
  CohortHero,
  CountryBreakdown,
  KPI_VALUES,
  LtvCurves,
  RetentionHeatmap,
  SAMPLE_MEMBERS,
  SAVED_COHORTS,
  SavedCohortsRail,
  SyncDestinations,
  type RetentionMetric,
  type SavedCohort,
} from "../../../../components/cohorts";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/cohorts",
)({
  component: CohortsRouteComponent,
});

function CohortsRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/cohorts",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <CohortsPage />;
}

function CohortsPage() {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string>(SAVED_COHORTS[0].id);
  const [metric, setMetric] = useState<RetentionMetric>("retention");

  const selected: SavedCohort = useMemo(
    () => SAVED_COHORTS.find((c) => c.id === selectedId) ?? SAVED_COHORTS[0],
    [selectedId],
  );

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="max-w-3xl">
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("cohorts.title")}
          </h1>
          <p className="mt-0.5 text-[13px] text-rv-mute-500">
            {t("cohorts.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("cohorts.actions.howCohortsWork")}
          </Button>
          <Button variant="flat" size="sm">
            <Download size={13} />
            {t("cohorts.actions.exportCsv")}
          </Button>
          <Button variant="solid-primary" size="sm">
            <Plus size={13} />
            {t("cohorts.actions.newCohort")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("cohorts.kpi.saved")}
          value={SAVED_COHORTS.length}
          description={t("cohorts.kpi.savedBreakdown", {
            groups: KPI_VALUES.groupCount,
            synced: KPI_VALUES.syncedCount,
          })}
        />
        <StatCard
          label={t("cohorts.kpi.avgRetention")}
          value="40.1%"
          description={t("cohorts.kpi.avgRetentionDelta", {
            value: KPI_VALUES.avgRetentionDelta,
          })}
          descriptionTone="success"
        />
        <StatCard
          label={t("cohorts.kpi.bestCohort")}
          value={KPI_VALUES.bestCohortName}
          description={t("cohorts.kpi.bestCohortValue", {
            value: KPI_VALUES.bestCohortValue,
            users: KPI_VALUES.bestCohortUsers,
          })}
        />
        <StatCard
          label={t("cohorts.kpi.blendedLtv")}
          value={KPI_VALUES.blendedLtv}
          description={t("cohorts.kpi.blendedLtvDelta", {
            value: KPI_VALUES.blendedLtvDelta,
          })}
          descriptionTone="success"
        />
      </div>

      <div className="grid items-start gap-4 max-[1280px]:grid-cols-1 grid-cols-[260px_minmax(0,1fr)]">
        <SavedCohortsRail
          cohorts={SAVED_COHORTS}
          selectedId={selected.id}
          onSelect={setSelectedId}
        />

        <div className="flex flex-col gap-4">
          <CohortHero cohort={selected} members={SAMPLE_MEMBERS} />
          <CohortBuilder matchCount={selected.size} />
          <RetentionHeatmap
            cohortName={selected.name}
            metric={metric}
            onMetricChange={setMetric}
          />

          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <LtvCurves />
            <CountryBreakdown />
          </div>

          <SyncDestinations />
        </div>
      </div>
    </>
  );
}
