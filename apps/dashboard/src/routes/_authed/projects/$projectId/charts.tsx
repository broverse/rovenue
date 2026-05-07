import { useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowUpDown, Plus, Search } from "lucide-react";
import { Button } from "../../../../ui/button";
import {
  AnnotationsPanel,
  CHART_CATALOG,
  ChannelDonut,
  ChartCatalog,
  ChartToolbar,
  FiltersCard,
  FunnelCard,
  GroupByCard,
  HourDayHeatmap,
  MrrChartPanel,
  SavedViewsCard,
  SqlPreviewCard,
  type ChartType,
  type GroupBy,
  type RangeOption,
} from "../../../../components/charts";
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
  return <ChartsPage />;
}

function ChartsPage() {
  const { t } = useTranslation();
  const [chartId, setChartId] = useState<string>("mrr");
  const [chartType, setChartType] = useState<ChartType>("area");
  const [range, setRange] = useState<RangeOption>("12M");
  const [compare, setCompare] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [starredIds, setStarredIds] = useState<ReadonlySet<string>>(
    () => new Set(CHART_CATALOG.filter((c) => c.star).map((c) => c.id)),
  );

  const selected = useMemo(
    () => CHART_CATALOG.find((c) => c.id === chartId) ?? CHART_CATALOG[0],
    [chartId],
  );

  const toggleStar = () => {
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (next.has(selected.id)) next.delete(selected.id);
      else next.add(selected.id);
      return next;
    });
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
          <Button variant="flat" size="sm">
            <ArrowUpDown size={13} />
            {t("charts.actions.exportCsv")}
          </Button>
          <Button variant="solid-primary" size="sm">
            <Plus size={13} />
            {t("charts.actions.newChart")}
          </Button>
        </div>
      </header>

      <div className="grid items-start gap-4 grid-cols-1 max-[1100px]:grid-cols-1 max-[1480px]:grid-cols-[220px_minmax(0,1fr)] min-[1481px]:grid-cols-[240px_minmax(0,1fr)_320px]">
        <ChartCatalog selectedId={chartId} onSelect={setChartId} />

        <main className="flex min-w-0 flex-col gap-3">
          <ChartToolbar
            titleKey={`charts.items.${selected.id}`}
            versionLabel={t("charts.toolbar.version")}
            starred={starredIds.has(selected.id)}
            onToggleStar={toggleStar}
            chartType={chartType}
            onChartTypeChange={setChartType}
            range={range}
            onRangeChange={setRange}
            compare={compare}
            onToggleCompare={() => setCompare((c) => !c)}
          />

          <MrrChartPanel chartType={chartType} compare={compare} />

          <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
            <ChannelDonut />
            <FunnelCard />
            <HourDayHeatmap />
          </div>

          <AnnotationsPanel />
        </main>

        <aside className="sticky top-[76px] hidden max-h-[calc(100vh-96px)] flex-col gap-3 overflow-y-auto min-[1481px]:flex">
          <FiltersCard />
          <GroupByCard value={groupBy} onChange={setGroupBy} />
          <SavedViewsCard />
          <SqlPreviewCard />
        </aside>
      </div>
    </>
  );
}
