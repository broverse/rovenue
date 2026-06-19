import { useEffect, useMemo } from "react";
import {
  Link,
  createFileRoute,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BookOpen, Plus } from "lucide-react";
import { Button, buttonVariants } from "../../../../../ui/button";
import { cn } from "../../../../../lib/cn";
import { StatCard } from "../../../../../ui/stat-card";
import {
  ExperimentDetailPanel,
  ExperimentsList,
  mapApiExperiment,
  type ExperimentScope,
  type ExperimentSummary,
} from "../../../../../components/experiments";
import { useExperiments } from "../../../../../lib/hooks/useExperiments";
import { useProject } from "../../../../../lib/hooks/useProject";

const SCOPE_VALUES: ReadonlyArray<ExperimentScope> = [
  "running",
  "completed",
  "draft",
  "all",
];
const SCOPE_SET = new Set<ExperimentScope>(SCOPE_VALUES);

type ExperimentsSearch = {
  scope?: ExperimentScope;
  selected?: string;
};

function parseScope(raw: unknown): ExperimentScope | undefined {
  if (typeof raw !== "string") return undefined;
  return SCOPE_SET.has(raw as ExperimentScope)
    ? (raw as ExperimentScope)
    : undefined;
}

export const Route = createFileRoute(
  "/_authed/projects/$projectId/experiments/",
)({
  validateSearch: (search: Record<string, unknown>): ExperimentsSearch => ({
    scope: parseScope(search.scope),
    selected:
      typeof search.selected === "string" && search.selected.length > 0
        ? search.selected
        : undefined,
  }),
  component: ExperimentsRouteComponent,
});

function ExperimentsRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/experiments/",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <ExperimentsPage projectId={projectId} />;
}

export function ExperimentsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: experiments = [] } = useExperiments({ projectId });

  const scope: ExperimentScope = search.scope ?? "running";
  const selectedId = search.selected ?? null;

  const updateSearch = (patch: Partial<ExperimentsSearch>) => {
    void navigate({
      search: (prev) => {
        const next: ExperimentsSearch = { ...prev, ...patch };
        if (!next.scope || next.scope === "running") delete next.scope;
        if (!next.selected) delete next.selected;
        return next;
      },
      replace: true,
    });
  };

  const setScope = (next: ExperimentScope) =>
    updateSearch({ scope: next, selected: undefined });
  const setSelectedId = (id: string) => updateSearch({ selected: id });

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

  // Default-select the first visible row when nothing is selected,
  // or when the selected key was filtered out by the current scope.
  // We URL-encode the experiment `key` (slug) — not the cuid2 db id —
  // so the URL stays human-readable.
  useEffect(() => {
    if (scoped.length === 0) return;
    if (!selectedId || !scoped.some((e) => e.key === selectedId)) {
      updateSearch({ selected: scoped[0]!.key });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, selectedId]);

  const selected = useMemo<ExperimentSummary | null>(() => {
    if (!selectedId) return null;
    return summaries.find((e) => e.key === selectedId) ?? null;
  }, [selectedId, summaries]);

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
          <Link
            to="/projects/$projectId/experiments/new"
            params={{ projectId }}
            className={cn(buttonVariants({ variant: "solid-primary", size: "sm" }))}
          >
            <Plus size={13} />
            {t("experiments.actions.newExperiment")}
          </Link>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("experiments.kpi.running")}
          value={scopeCounts.running.toLocaleString()}
        />
        <StatCard
          label={t("experiments.kpi.draft")}
          value={scopeCounts.draft.toLocaleString()}
        />
        <StatCard
          label={t("experiments.kpi.shippedWins")}
          value={
            <span className="text-rv-success">{scopeCounts.completed}</span>
          }
          descriptionTone="success"
        />
        <StatCard
          label={t("experiments.kpi.total")}
          value={scopeCounts.all.toLocaleString()}
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

        {selected ? (
          <ExperimentDetailPanel
            experiment={selected}
            projectId={projectId}
            showDetailsLink
          />
        ) : (
          <div className="flex h-[200px] min-w-0 items-center justify-center rounded-lg border border-rv-divider bg-rv-c1 text-[13px] text-rv-mute-500">
            {t("experiments.list.empty")}
          </div>
        )}
      </div>
    </>
  );
}
