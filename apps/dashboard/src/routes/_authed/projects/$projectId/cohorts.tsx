import { useEffect, useMemo, useState } from "react";
import {
  createFileRoute,
  Outlet,
  useChildMatches,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BookOpen, Plus } from "lucide-react";
import { Button } from "../../../../ui/button";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  useCohortRetention,
  useProjectCohorts,
} from "../../../../lib/hooks/useProjectCohorts";
import {
  CohortDefinitionCard,
  CohortHero,
  RetentionHeatmap,
  SavedCohortsRail,
  w4Pct,
  type RetentionMetric,
} from "../../../../components/cohorts";

interface CohortsSearch {
  selected?: string;
}

export const Route = createFileRoute(
  "/_authed/projects/$projectId/cohorts",
)({
  component: CohortsRouteComponent,
  validateSearch: (raw: Record<string, unknown>): CohortsSearch => ({
    selected: typeof raw["selected"] === "string" ? raw["selected"] : undefined,
  }),
});

function CohortsRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/cohorts",
  });
  const { data: project } = useProject(projectId);
  // `cohorts/new` and `cohorts/$cohortId` are children of this
  // route. When a child is active, defer to its <Outlet />
  // instead of stacking the listing on top of the form.
  const childMatches = useChildMatches();
  if (!project) return null;
  if (childMatches.length > 0) {
    return <Outlet />;
  }
  return <CohortsPage projectId={projectId} />;
}

function CohortsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({
    from: "/_authed/projects/$projectId/cohorts",
  });

  const list = useProjectCohorts(projectId);
  const cohorts = list.data?.cohorts ?? [];

  const selectedId = useMemo(() => {
    if (search.selected && cohorts.some((c) => c.id === search.selected)) {
      return search.selected;
    }
    return cohorts[0]?.id ?? null;
  }, [search.selected, cohorts]);

  // Reconcile the URL if the selected id is missing or invalid.
  useEffect(() => {
    if (
      search.selected &&
      cohorts.length > 0 &&
      !cohorts.some((c) => c.id === search.selected)
    ) {
      navigate({
        to: "/projects/$projectId/cohorts",
        params: { projectId },
        search: selectedId ? { selected: selectedId } : {},
        replace: true,
      });
    }
  }, [search.selected, cohorts, selectedId, navigate, projectId]);

  const selected = cohorts.find((c) => c.id === selectedId) ?? null;

  const retention = useCohortRetention({
    projectId,
    id: selectedId ?? "",
    granularity: "week",
    periods: 13,
  });

  const [metric, setMetric] = useState<RetentionMetric>("retention");

  const onSelect = (id: string) =>
    navigate({
      to: "/projects/$projectId/cohorts",
      params: { projectId },
      search: { selected: id },
      replace: true,
    });

  const goNew = () =>
    navigate({
      to: "/projects/$projectId/cohorts/new",
      params: { projectId },
    });

  const retentionPoints = retention.data?.points ?? [];
  const retentionSize = retention.data?.size ?? null;
  const retentionW4 = retention.data ? w4Pct(retention.data.points) : null;
  const retentionError = retention.error
    ? t("cohorts.hero.retentionFailed")
    : null;
  const refreshedLabel = retention.dataUpdatedAt
    ? new Date(retention.dataUpdatedAt).toLocaleTimeString()
    : "—";

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
          <Button variant="solid-primary" size="sm" onClick={goNew}>
            <Plus size={13} />
            {t("cohorts.actions.newCohort")}
          </Button>
        </div>
      </header>

      <div className="grid items-start gap-4 max-[1280px]:grid-cols-1 grid-cols-[260px_minmax(0,1fr)]">
        <SavedCohortsRail
          cohorts={cohorts}
          selectedId={selectedId}
          onSelect={onSelect}
          onNew={goNew}
        />

        <div className="flex flex-col gap-4">
          {list.isLoading && cohorts.length === 0 ? (
            <div className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-10 text-center text-[13px] text-rv-mute-500">
              {t("common.loading")}
            </div>
          ) : list.error ? (
            <div className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-10 text-center">
              <p className="text-[13px] text-rv-danger">
                {t("cohorts.list.loadFailed")}
              </p>
              <div className="mt-3 inline-flex">
                <Button
                  variant="flat"
                  size="sm"
                  onClick={() => list.refetch()}
                >
                  {t("common.retry")}
                </Button>
              </div>
            </div>
          ) : !selected ? (
            <EmptyState onNew={goNew} />
          ) : (
            <>
              <CohortHero
                cohort={selected}
                size={retentionSize}
                w4Pct={retentionW4}
              />
              <CohortDefinitionCard
                projectId={projectId}
                cohort={selected}
                matchCount={retentionSize}
                refreshedLabel={refreshedLabel}
              />
              <RetentionHeatmap
                cohortName={selected.name}
                metric={metric}
                onMetricChange={setMetric}
                points={retentionPoints}
                size={retentionSize}
                loading={retention.isLoading}
                error={retentionError}
                onRetry={() => retention.refetch()}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-12 text-center">
      <h3 className="text-[15px] font-semibold">{t("cohorts.hero.emptyState")}</h3>
      <p className="mt-1 text-[12px] text-rv-mute-500">
        {t("cohorts.list.emptyCta")}
      </p>
      <div className="mt-4 inline-flex">
        <Button variant="solid-primary" size="sm" onClick={onNew}>
          <Plus size={13} />
          {t("cohorts.actions.newCohort")}
        </Button>
      </div>
    </div>
  );
}
