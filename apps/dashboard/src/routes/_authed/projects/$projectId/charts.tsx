import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Plus, Search } from "lucide-react";
import type { ChartCatalogEntry } from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import {
  AnnotationsPanel,
  ChannelDonut,
  ChartCatalog,
  ChartToolbar,
  FunnelCard,
  HourDayHeatmap,
  MrrChartPanel,
  NewChartDialog,
  SeriesChartPanel,
  SqlPreviewCard,
  type ChartType,
  type RangeOption,
} from "../../../../components/charts";
import {
  useChartCatalog,
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

function entryLabel(
  entry: ChartCatalogEntry,
  t: (key: string) => string,
): string {
  return entry.kind === "system" ? t(`charts.items.${entry.id}`) : entry.name;
}

export function ChartsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openInQueries = () =>
    void navigate({ to: "/projects/$projectId/queries", params: { projectId } });
  const catalogQuery = useChartCatalog(projectId);
  const entries = useMemo(
    () => catalogQuery.data?.entries ?? [],
    [catalogQuery.data],
  );

  const [chartId, setChartId] = useState<string>("mrr");
  const [chartType, setChartType] = useState<ChartType>("area");
  const [range, setRange] = useState<RangeOption>("12M");
  const [compare, setCompare] = useState(true);
  const [starredIds, setStarredIds] = useState<ReadonlySet<string>>(
    DEFAULT_STARRED_IDS,
  );
  const [newChartOpen, setNewChartOpen] = useState(false);

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
          <Button variant="flat" size="sm" onClick={openInQueries}>
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

          {chartId === "mrr" ? (
            <MrrChartPanel
              projectId={projectId}
              chartType={chartType}
              compare={compare}
              range={range}
            />
          ) : (
            <SeriesChartPanel
              projectId={projectId}
              chartId={chartId}
              chartType={chartType}
              range={range}
            />
          )}

          <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
            <ChannelDonut projectId={projectId} />
            <FunnelCard projectId={projectId} />
            <HourDayHeatmap projectId={projectId} />
          </div>

          <AnnotationsPanel projectId={projectId} />
        </main>

        <aside className="sticky top-[76px] hidden max-h-[calc(100vh-96px)] flex-col gap-3 overflow-y-auto min-[1481px]:flex">
          <SqlPreviewCard onOpenInQueries={openInQueries} />
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
