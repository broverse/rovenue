import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { useProject } from "../../../../lib/hooks/useProject";
import { useProjectMrr } from "../../../../lib/hooks/useProjectMrr";
import {
  ExperimentsPanel,
  KpiCard,
  RecentActivityPanel,
  RevenueChartPanel,
  SystemHealthPanel,
  TopProductsPanel,
} from "../../../../components/dashboard";
import { RefreshCw } from "lucide-react";
import { Button } from "../../../../ui";
import {
  activeSeries,
  categories,
  churnSeries,
  experiments,
  genActivity,
  healthServices,
  mrrSeries,
  revenueMetrics,
  topProducts,
  trialSeries,
} from "../../../../components/dashboard/mock-data";
import type { ActivityEvent } from "../../../../components/dashboard";

const USD = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Latest day's grossUsd, formatted as "12,847.20". */
function formatLatestMrr(points: ReadonlyArray<{ grossUsd: string }>): string {
  if (points.length === 0) return "0.00";
  const last = Number(points[points.length - 1]!.grossUsd);
  if (!Number.isFinite(last)) return points[points.length - 1]!.grossUsd;
  return USD.format(last);
}

/**
 * % change between the first and last grossUsd value in the
 * window. Returns null for sparse windows where a delta would
 * be misleading.
 */
function mrrDelta(
  points: ReadonlyArray<{ grossUsd: string }>,
): { value: string; kind: "success" | "danger" } | null {
  if (points.length < 2) return null;
  const first = Number(points[0]!.grossUsd);
  const last = Number(points[points.length - 1]!.grossUsd);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) {
    return null;
  }
  const pct = ((last - first) / first) * 100;
  const kind = pct >= 0 ? "success" : "danger";
  const sign = pct >= 0 ? "+" : "";
  return { value: `${sign}${pct.toFixed(1)}%`, kind };
}

export const Route = createFileRoute("/_authed/projects/$projectId/")({
  component: ProjectOverview,
});

const LIVE_TICK_MS = 3200;
const NEW_EVENT_PROB = 0.55;

function ProjectOverview() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/" });
  const { data: project } = useProject(projectId);
  const { data: mrr } = useProjectMrr({ projectId });
  const [events, setEvents] = useState<ActivityEvent[]>(() => genActivity(10));

  // Derive the MRR KPI card inputs from the daily-series response.
  // Fall back to mock series while the query is loading so the
  // page never renders a blank tile.
  const mrrCard = useMemo(() => {
    const points = mrr?.points ?? [];
    if (points.length === 0) {
      return {
        value: "12,847.20",
        delta: "12.4%",
        deltaKind: "success" as const,
        sparkData: mrrSeries,
      };
    }
    const delta = mrrDelta(points);
    return {
      value: formatLatestMrr(points),
      delta: delta?.value ?? null,
      deltaKind: delta?.kind ?? ("success" as const),
      sparkData: points.map((p) => Number(p.grossUsd)),
    };
  }, [mrr]);

  // Live ticker — bumps secondsAgo on existing rows and occasionally drops
  // a new one in. The DashboardShell owns the global liveOn flag; for now
  // we just always animate while this page is mounted.
  useEffect(() => {
    const id = setInterval(() => {
      setEvents((prev) => {
        const aged: ActivityEvent[] = prev.map((e) => ({ ...e, secondsAgo: e.secondsAgo + 4, isNew: false }));
        if (Math.random() < NEW_EVENT_PROB) {
          const fresh: ActivityEvent = {
            ...genActivity(1)[0]!,
            secondsAgo: 1,
            isNew: true,
            id: `evt_${Math.random().toString(36).slice(2, 10)}`,
          };
          return [fresh, ...aged].slice(0, 10);
        }
        return aged;
      });
    }, LIVE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  if (!project) return null;

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">{t("overview.title")}</h1>
          <p className="mt-0.5 text-[13px] text-rv-mute-500">
            <Trans
              i18nKey="overview.subtitle"
              values={{ name: project.name }}
              components={[<span key="n" className="text-rv-mute-700" />]}
            />
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat">
            <RefreshCw size={13} />
            {t("common.refresh")}
          </Button>
          <Button variant="flat">{t("common.export")}</Button>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 md:col-span-3">
          <KpiCard
            label={t("overview.kpi.mrr")}
            currency="$"
            value={mrrCard.value}
            delta={mrrCard.delta}
            deltaKind={mrrCard.deltaKind}
            sparkData={mrrCard.sparkData}
            sparkColor="var(--color-rv-accent-500)"
          />
        </div>
        <div className="col-span-12 md:col-span-3">
          <KpiCard
            label={t("overview.kpi.activeSubs")}
            value="2,431"
            delta="184"
            deltaKind="success"
            sparkData={activeSeries}
            sparkColor="var(--color-rv-success)"
          />
        </div>
        <div className="col-span-12 md:col-span-3">
          <KpiCard
            label={t("overview.kpi.trialToPaid")}
            value="42.8"
            unit="%"
            delta="1.1pp"
            deltaKind="danger"
            sparkData={trialSeries}
            sparkColor="var(--color-rv-warning)"
          />
        </div>
        <div className="col-span-12 md:col-span-3">
          <KpiCard
            label={t("overview.kpi.netChurn")}
            value="-3.2"
            unit="%"
            delta={t("overview.kpi.improved")}
            deltaKind="success"
            sparkData={churnSeries}
            sparkColor="var(--color-rv-danger)"
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8">
          <RevenueChartPanel metrics={revenueMetrics} categories={categories} initialMetric="MRR" />
        </div>
        <div className="col-span-12 lg:col-span-4">
          <TopProductsPanel products={topProducts} />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-6">
          <RecentActivityPanel events={events} live />
        </div>
        <div className="col-span-12 lg:col-span-6">
          <ExperimentsPanel experiments={experiments} />
        </div>
      </div>

      <div className="mt-4">
        <SystemHealthPanel services={healthServices} />
      </div>

      <div className="mt-8 flex items-center justify-between border-t border-rv-divider pt-4 text-[12px] text-rv-mute-500">
        <span className="font-rv-mono">{t("overview.footer.version")}</span>
        <div className="flex gap-4">
          <span>
            <Trans
              i18nKey="overview.footer.lastSync"
              values={{ value: t("overview.footer.secondsAgo", { seconds: 30 }) }}
              components={[<span key="v" className="font-rv-mono" />]}
            />
          </span>
          <span className="font-rv-mono">{t("overview.footer.shortcuts")}</span>
        </div>
      </div>
    </>
  );
}
