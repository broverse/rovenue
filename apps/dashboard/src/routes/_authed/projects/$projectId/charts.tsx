import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Plus, Search } from "lucide-react";
import type { ChartCatalogEntry } from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import {
  AnnotationsPanel,
  ChannelDonut,
  ChartCatalog,
  ChartToolbar,
  FiltersCard,
  FunnelCard,
  GroupByCard,
  HourDayHeatmap,
  MrrChartPanel,
  NewChartDialog,
  SavedViewsCard,
  SqlPreviewCard,
  type ChartType,
  type FilterSelection,
  type GroupBy,
  type RangeOption,
} from "../../../../components/charts";
import {
  useChartCatalog,
  useChartFilterOptions,
  useDeleteCustomChart,
} from "../../../../lib/hooks/useProjectCharts";
import { useProject } from "../../../../lib/hooks/useProject";

export const Route = createFileRoute("/_authed/projects/$projectId/charts")({
  component: ChartsRoute,
});

function ChartsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/charts",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <ChartsPage projectId={projectId} />;
}

// System charts that start out starred — mirrors the visual
// affordance from the original hard-coded library while we wait
// on a per-user starring endpoint.
const DEFAULT_STARRED_IDS: ReadonlySet<string> = new Set([
  "mrr",
  "rev_per_install",
  "churn",
]);

const RANGE_TO_WINDOW_DAYS: Record<RangeOption, number> = {
  "1M": 30,
  "3M": 90,
  "6M": 180,
  "12M": 365,
  YTD: 180,
  All: 365,
};

function entryLabel(
  entry: ChartCatalogEntry,
  t: (key: string) => string,
): string {
  return entry.kind === "system" ? t(`charts.items.${entry.id}`) : entry.name;
}

const EMPTY_FILTERS: FilterSelection = {
  platform: [],
  country: [],
  productGroup: [],
};

const filtersStorageKey = (projectId: string): string =>
  `rovenue.charts.filters.${projectId}`;

/**
 * Per-chart filter selection persisted to localStorage. Keyed by
 * project so two projects in adjacent tabs don't bleed selections
 * into each other. We persist on every change — the surface is
 * tiny and the writes only happen when the user actually moves a
 * chip, so the work is negligible.
 */
function useChartFiltersByChart(
  projectId: string,
  chartId: string,
): [FilterSelection, (next: FilterSelection) => void] {
  const [byChart, setByChart] = useState<Record<string, FilterSelection>>(
    () => {
      if (typeof window === "undefined") return {};
      try {
        const raw = window.localStorage.getItem(filtersStorageKey(projectId));
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return {};
        return parsed as Record<string, FilterSelection>;
      } catch {
        return {};
      }
    },
  );

  const current = byChart[chartId] ?? EMPTY_FILTERS;

  const setCurrent = useCallback(
    (next: FilterSelection) => {
      setByChart((prev) => {
        const updated = { ...prev, [chartId]: next };
        try {
          window.localStorage.setItem(
            filtersStorageKey(projectId),
            JSON.stringify(updated),
          );
        } catch {
          // Storage may be full or disabled; the in-memory state
          // still updates so the session keeps working.
        }
        return updated;
      });
    },
    [chartId, projectId],
  );

  return [current, setCurrent];
}

function ChartsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const catalogQuery = useChartCatalog(projectId);
  const entries = useMemo(
    () => catalogQuery.data?.entries ?? [],
    [catalogQuery.data],
  );

  const [chartId, setChartId] = useState<string>("mrr");
  const [chartType, setChartType] = useState<ChartType>("area");
  const [range, setRange] = useState<RangeOption>("12M");
  const [compare, setCompare] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [starredIds, setStarredIds] = useState<ReadonlySet<string>>(
    DEFAULT_STARRED_IDS,
  );
  const [newChartOpen, setNewChartOpen] = useState(false);
  const [filters, setFilters] = useChartFiltersByChart(projectId, chartId);

  // The catalog can grow / shrink — if the selected id disappears
  // (e.g. the user just deleted their custom chart), snap back to
  // MRR so the toolbar never goes blank.
  useEffect(() => {
    if (entries.length === 0) return;
    if (!entries.some((e) => e.id === chartId)) {
      setChartId(entries[0]?.id ?? "mrr");
    }
  }, [entries, chartId]);

  const selected = useMemo(
    () => entries.find((e) => e.id === chartId) ?? entries[0],
    [entries, chartId],
  );

  // Pulling defaults from the catalog entry happens on the click,
  // not in an effect — the alternative would chase `selected.id`
  // and fight the toolbar's local controls every render.
  const onSelectChart = (next: string) => {
    setChartId(next);
    const entry = entries.find((e) => e.id === next);
    if (entry) {
      setChartType(entry.chartType);
      setRange(entry.range);
    }
  };

  const filterOptionsQuery = useChartFilterOptions({
    projectId,
    windowDays: RANGE_TO_WINDOW_DAYS[range],
  });
  const deleteChart = useDeleteCustomChart(projectId);

  const toggleStar = () => {
    if (!selected) return;
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (next.has(selected.id)) next.delete(selected.id);
      else next.add(selected.id);
      return next;
    });
  };

  const onDelete = async (entry: ChartCatalogEntry) => {
    if (entry.kind !== "custom") return;
    const ok = window.confirm(
      t("charts.catalog.deleteConfirm", {
        defaultValue: 'Delete "{{name}}"? This affects the whole project.',
        name: entry.name,
      }),
    );
    if (!ok) return;
    await deleteChart.mutateAsync(entry.id);
  };

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="max-w-3xl">
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("charts.title")}
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t("charts.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <Search size={13} />
            {t("charts.actions.openInQueries")}
          </Button>
          <Button
            variant="solid-primary"
            size="sm"
            onClick={() => setNewChartOpen(true)}
          >
            <Plus size={13} />
            {t("charts.actions.newChart")}
          </Button>
        </div>
      </header>

      <div className="grid items-start gap-4 grid-cols-1 max-[1100px]:grid-cols-1 max-[1480px]:grid-cols-[220px_minmax(0,1fr)] min-[1481px]:grid-cols-[240px_minmax(0,1fr)_320px]">
        <ChartCatalog
          entries={entries}
          selectedId={selected?.id ?? ""}
          starredIds={starredIds}
          onSelect={onSelectChart}
          onDelete={onDelete}
          loading={catalogQuery.isLoading}
        />

        <main className="flex min-w-0 flex-col gap-3">
          <ChartToolbar
            title={selected ? entryLabel(selected, t) : ""}
            versionLabel={t("charts.toolbar.version")}
            starred={selected ? starredIds.has(selected.id) : false}
            onToggleStar={toggleStar}
            chartType={chartType}
            onChartTypeChange={setChartType}
            range={range}
            onRangeChange={setRange}
            compare={compare}
            onToggleCompare={() => setCompare((c) => !c)}
          />

          <MrrChartPanel
            projectId={projectId}
            chartType={chartType}
            compare={compare}
            range={range}
          />

          <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
            <ChannelDonut projectId={projectId} />
            <FunnelCard projectId={projectId} />
            <HourDayHeatmap projectId={projectId} />
          </div>

          <AnnotationsPanel projectId={projectId} />
        </main>

        <aside className="sticky top-[76px] hidden max-h-[calc(100vh-96px)] flex-col gap-3 overflow-y-auto min-[1481px]:flex">
          <FiltersCard
            value={filters}
            onChange={setFilters}
            options={filterOptionsQuery.data}
            loading={filterOptionsQuery.isLoading}
          />
          <GroupByCard value={groupBy} onChange={setGroupBy} />
          <SavedViewsCard />
          <SqlPreviewCard />
        </aside>
      </div>

      <NewChartDialog
        projectId={projectId}
        open={newChartOpen}
        onClose={() => setNewChartOpen(false)}
        onCreated={onSelectChart}
      />
    </>
  );
}
