import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useProject } from "../../../../lib/hooks/useProject";
import { useProjectMrr } from "../../../../lib/hooks/useProjectMrr";
import { useProjectOverview } from "../../../../lib/hooks/useProjectOverview";
import { useExperiments } from "../../../../lib/hooks/useExperiments";
import {
  ExperimentsPanel,
  KpiCard,
  RecentActivityPanel,
  RevenueChartPanel,
  SystemHealthPanel,
  TopProductsPanel,
} from "../../../../components/dashboard";
import { EngagementCard, LtvDistributionCard, PredictedLtvCard, RevenueKpisCard } from "../../../../components/charts";
import type {
  ActivityEvent,
  ActivityKind,
  Experiment,
  HealthService,
  TopProduct,
} from "../../../../components/dashboard";
import type { ChartSeries } from "../../../../components/dashboard";
import { Button } from "../../../../ui";
import type {
  ExperimentListItem,
  OverviewActivityEvent,
  OverviewSystemHealth,
  OverviewTopProduct,
  ProjectOverviewResponse,
  RevenueEventTypeName,
} from "@rovenue/shared";

const USD = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const NULL_DASH = "—";

/** Latest day's grossUsd, formatted as "12,847.20". */
function formatLatestMrr(points: ReadonlyArray<{ grossUsd: string }>): string {
  if (points.length === 0) return NULL_DASH;
  const last = Number(points[points.length - 1]!.grossUsd);
  if (!Number.isFinite(last)) return points[points.length - 1]!.grossUsd;
  return USD.format(last);
}

/** % delta across the visible series. Returns null for sparse windows. */
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

function formatPctDelta(
  value: number | null,
): { value: string; kind: "success" | "danger" } | null {
  if (value === null || !Number.isFinite(value)) return null;
  const sign = value >= 0 ? "+" : "";
  return {
    value: `${sign}${value.toFixed(1)}%`,
    kind: value >= 0 ? "success" : "danger",
  };
}

function formatAbsDelta(value: number): { value: string; kind: "success" | "danger" } {
  const sign = value >= 0 ? "+" : "";
  return {
    value: `${sign}${value.toLocaleString()}`,
    kind: value >= 0 ? "success" : "danger",
  };
}

/** Net-churn is inverted: lower is better, so a positive Δpp renders as danger. */
function formatChurnDeltaPp(
  value: number | null,
): { value: string; kind: "success" | "danger" } | null {
  if (value === null || !Number.isFinite(value)) return null;
  const sign = value >= 0 ? "+" : "";
  return {
    value: `${sign}${value.toFixed(2)}pp`,
    kind: value <= 0 ? "success" : "danger",
  };
}

// =============================================================
// Overview-response → panel-prop adapters
// =============================================================

const ACTIVITY_VISUAL: Record<
  RevenueEventTypeName,
  { icon: ActivityKind; color: string; labelKey: string; signAmount: 1 | -1 }
> = {
  INITIAL: { icon: "up", color: "var(--color-rv-accent-500)", labelKey: "new_subscription", signAmount: 1 },
  RENEWAL: { icon: "renew", color: "var(--color-rv-success)", labelKey: "renewal", signAmount: 1 },
  TRIAL_CONVERSION: { icon: "up", color: "var(--color-rv-cyan)", labelKey: "trial_started", signAmount: 1 },
  CANCELLATION: { icon: "down", color: "var(--color-rv-warning)", labelKey: "cancellation", signAmount: 1 },
  REFUND: { icon: "down", color: "var(--color-rv-mute-600)", labelKey: "refund", signAmount: -1 },
  REACTIVATION: { icon: "up", color: "var(--color-rv-accent-500)", labelKey: "renewal", signAmount: 1 },
  CREDIT_PURCHASE: { icon: "up", color: "var(--color-rv-cyan)", labelKey: "new_subscription", signAmount: 1 },
};

function shortSubscriberId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function secondsAgo(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

function toPanelActivity(
  events: ReadonlyArray<OverviewActivityEvent>,
  nowMs: number,
): ActivityEvent[] {
  return events.map((e) => {
    const v = ACTIVITY_VISUAL[e.type];
    const amountNum = e.amountUsd !== null ? Number(e.amountUsd) : null;
    const signedAmount =
      amountNum === null || !Number.isFinite(amountNum)
        ? null
        : amountNum * v.signAmount;
    return {
      id: e.id,
      type: e.type,
      color: v.color,
      icon: v.icon,
      label: v.labelKey,
      user: shortSubscriberId(e.subscriberId),
      product: e.productName ?? e.productId,
      amount: signedAmount,
      secondsAgo: secondsAgo(e.eventDate, nowMs),
    };
  });
}

function toPanelTopProducts(
  rows: ReadonlyArray<OverviewTopProduct>,
): TopProduct[] {
  return rows.map((r) => ({
    name: r.displayName,
    sku: r.identifier,
    rev: Math.round(Number(r.grossUsd)),
    pct: Math.round(r.pct),
    subs: r.subscriberCount,
  }));
}

function toPanelSystemHealth(
  rows: ReadonlyArray<OverviewSystemHealth>,
): HealthService[] {
  return rows.map((r) => ({
    name: r.name,
    status: r.status,
    metric: r.metric,
  }));
}

// =============================================================
// Experiments — list-item → panel adapter
// =============================================================
//
// The list endpoint doesn't (yet) carry a Bayesian-confidence or
// uplift number — those land with the analytics rollup. Until
// then we pass `confidence: null` and `uplift: null`; the panel
// hides the progress bar and trims its description text.

const DAY_MS = 86_400_000;

function statusToPanel(s: ExperimentListItem["status"]): Experiment["status"] | null {
  switch (s) {
    case "RUNNING":
    case "PAUSED":
      return "running";
    case "COMPLETED":
      return "completed";
    case "DRAFT":
      return null;
  }
}

function daysSince(iso: string | null, nowMs: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

function toPanelExperiments(
  rows: ReadonlyArray<ExperimentListItem>,
  nowMs: number,
): Experiment[] {
  const out: Experiment[] = [];
  for (const row of rows) {
    const status = statusToPanel(row.status);
    if (!status) continue;
    const winnerName = row.winnerVariantId
      ? (row.variants.find((v) => v.id === row.winnerVariantId)?.name ?? row.winnerVariantId)
      : undefined;
    out.push({
      key: row.key,
      status,
      days: daysSince(row.startedAt, nowMs),
      variants: row.variants.length,
      confidence: null,
      uplift: null,
      winner: winnerName,
    });
  }
  // Most recently active first — running before completed, then by start.
  return out.sort((a, b) => {
    if (a.status !== b.status) return a.status === "running" ? -1 : 1;
    return (b.days ?? 0) - (a.days ?? 0);
  });
}

// =============================================================
// Revenue chart — overview sparks → ChartSeries
// =============================================================
//
// The overview gives us three daily series across the comparison
// window: gross USD, active subscribers, and net-churn %. We map
// each to a single-series ChartSeries so the panel's metric
// switcher can flip between them without a second fetch.

function buildCategories(fromIso: string, days: number): string[] {
  const start = new Date(fromIso);
  if (Number.isNaN(start.getTime())) return [];
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * DAY_MS);
    out.push(`${d.toLocaleString("en", { month: "short" })} ${d.getDate()}`);
  }
  return out;
}

function buildRevenueMetrics(
  overview: ProjectOverviewResponse,
  t: (k: string) => string,
): { metrics: Record<string, ChartSeries[]>; categories: string[] } {
  const categories = buildCategories(overview.window.from, overview.window.days);
  const gross = overview.kpis.mrr.spark.map((s) => Number(s) || 0);
  const active = overview.kpis.activeSubscribers.spark.map((n) => Number(n) || 0);
  const churn = overview.kpis.netChurnPct.spark.map((n) => Number(n) || 0);

  const metrics: Record<string, ChartSeries[]> = {
    [t("panels.revenue.metrics.mrr")]: [
      {
        key: "gross",
        label: t("panels.revenue.series.gross"),
        color: "var(--color-rv-accent-500)",
        data: gross,
      },
    ],
    [t("panels.revenue.metrics.activeSubs")]: [
      {
        key: "active",
        label: t("panels.revenue.series.active"),
        color: "var(--color-rv-success)",
        data: active,
      },
    ],
    [t("panels.revenue.metrics.netChurn")]: [
      {
        key: "churn",
        label: t("panels.revenue.series.churn"),
        color: "var(--color-rv-danger)",
        data: churn,
      },
    ],
  };
  return { metrics, categories };
}

export const Route = createFileRoute("/_authed/projects/$projectId/")({
  component: ProjectOverview,
});

const LIVE_TICK_MS = 3200;

function ProjectOverview() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/" });
  const { data: project } = useProject(projectId);
  const { data: mrr } = useProjectMrr({ projectId });
  const {
    data: overview,
    refetch: refetchOverview,
    isFetching: isFetchingOverview,
  } = useProjectOverview({ projectId });
  const {
    data: experiments,
    refetch: refetchExperiments,
    isFetching: isFetchingExperiments,
  } = useExperiments({
    projectId,
  });
  const isRefreshing = isFetchingOverview || isFetchingExperiments;
  const [now, setNow] = useState<number>(() => Date.now());

  // Re-render every few seconds so the "Xm ago" labels stay
  // current without refetching. Refetches are user-initiated via
  // the Refresh button.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // -------- KPI cards --------

  // MRR — prefer the dedicated `mrr` series since the overview's
  // gross_usd is a per-day decimal-as-string and the page already
  // builds the "latest day" delta from the MRR endpoint. Falls
  // back to the overview spark when the MRR query is in flight.
  const mrrCard = useMemo(() => {
    const points = mrr?.points ?? [];
    if (points.length === 0) {
      const ov = overview?.kpis.mrr;
      if (ov && ov.spark.length > 0) {
        const last = Number(ov.current);
        const delta = formatPctDelta(ov.deltaPct);
        return {
          value: Number.isFinite(last) ? USD.format(last) : ov.current,
          delta: delta?.value ?? null,
          deltaKind: delta?.kind ?? ("success" as const),
          sparkData: ov.spark.map((v) => Number(v)),
        };
      }
      return {
        value: NULL_DASH,
        delta: null,
        deltaKind: "success" as const,
        sparkData: [] as number[],
      };
    }
    const delta = mrrDelta(points);
    return {
      value: formatLatestMrr(points),
      delta: delta?.value ?? null,
      deltaKind: delta?.kind ?? ("success" as const),
      sparkData: points.map((p) => Number(p.grossUsd)),
    };
  }, [mrr, overview]);

  const activeSubsCard = useMemo(() => {
    const k = overview?.kpis.activeSubscribers;
    if (!k) {
      return {
        value: NULL_DASH,
        delta: null,
        deltaKind: "success" as const,
        sparkData: [] as number[],
      };
    }
    const delta = formatAbsDelta(k.deltaAbs);
    return {
      value: k.current.toLocaleString(),
      delta: delta.value,
      deltaKind: delta.kind,
      sparkData: k.spark,
    };
  }, [overview]);

  const trialCard = useMemo(() => {
    const k = overview?.kpis.trialToPaid;
    if (!k || k.ratePct === null) {
      // Backend returns null until Phase 3.3 ships the
      // subscription-lifecycle rollup that this metric needs.
      return {
        value: NULL_DASH,
        unit: undefined as string | undefined,
        delta: null,
        deltaKind: "success" as const,
        sparkData: k?.spark ?? ([] as number[]),
      };
    }
    const delta = formatPctDelta(k.deltaPp);
    return {
      value: k.ratePct.toFixed(1),
      unit: "%",
      delta: delta?.value ?? null,
      deltaKind: delta?.kind ?? ("success" as const),
      sparkData: k.spark,
    };
  }, [overview]);

  const churnCard = useMemo(() => {
    const k = overview?.kpis.netChurnPct;
    if (!k || k.current === null) {
      return {
        value: NULL_DASH,
        unit: undefined as string | undefined,
        delta: null,
        deltaKind: "success" as const,
        sparkData: k?.spark ?? ([] as number[]),
      };
    }
    const delta = formatChurnDeltaPp(k.deltaPp);
    return {
      value: k.current.toFixed(1),
      unit: "%",
      delta: delta?.value ?? null,
      deltaKind: delta?.kind ?? ("success" as const),
      sparkData: k.spark,
    };
  }, [overview]);

  // -------- Panels --------

  const panelActivity = useMemo<ReadonlyArray<ActivityEvent>>(() => {
    if (!overview) return [];
    return toPanelActivity(overview.recentActivity, now);
  }, [overview, now]);

  const panelTopProducts = useMemo<ReadonlyArray<TopProduct>>(() => {
    if (!overview) return [];
    return toPanelTopProducts(overview.topProducts);
  }, [overview]);

  const panelHealth = useMemo<ReadonlyArray<HealthService>>(() => {
    if (!overview) return [];
    return toPanelSystemHealth(overview.systemHealth);
  }, [overview]);

  const panelExperiments = useMemo<ReadonlyArray<Experiment>>(() => {
    if (!experiments) return [];
    return toPanelExperiments(experiments, now);
  }, [experiments, now]);

  const revenueChart = useMemo(() => {
    if (!overview) {
      return {
        metrics: {} as Record<string, ChartSeries[]>,
        categories: [] as string[],
        initial: undefined as string | undefined,
      };
    }
    const { metrics, categories } = buildRevenueMetrics(overview, t);
    return {
      metrics,
      categories,
      initial: t("panels.revenue.metrics.mrr"),
    };
  }, [overview, t]);

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
          <Button
            variant="flat"
            disabled={isRefreshing}
            onClick={() => {
              void refetchOverview();
              void refetchExperiments();
            }}
          >
            <RefreshCw size={13} className={isRefreshing ? "animate-spin" : undefined} />
            {t("common.refresh")}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 md:col-span-3">
          <KpiCard
            label={t("overview.kpi.mrr")}
            currency={mrrCard.value === NULL_DASH ? undefined : "$"}
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
            value={activeSubsCard.value}
            delta={activeSubsCard.delta}
            deltaKind={activeSubsCard.deltaKind}
            sparkData={activeSubsCard.sparkData}
            sparkColor="var(--color-rv-success)"
          />
        </div>
        <div className="col-span-12 md:col-span-3">
          <KpiCard
            label={t("overview.kpi.trialToPaid")}
            value={trialCard.value}
            unit={trialCard.unit}
            delta={trialCard.delta}
            deltaKind={trialCard.deltaKind}
            sparkData={trialCard.sparkData}
            sparkColor="var(--color-rv-warning)"
          />
        </div>
        <div className="col-span-12 md:col-span-3">
          <KpiCard
            label={t("overview.kpi.netChurn")}
            value={churnCard.value}
            unit={churnCard.unit}
            delta={churnCard.delta}
            deltaKind={churnCard.deltaKind}
            sparkData={churnCard.sparkData}
            sparkColor="var(--color-rv-danger)"
          />
        </div>
      </div>

      <div className="mt-4">
        <RevenueKpisCard projectId={projectId} />
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8">
          <RevenueChartPanel
            metrics={revenueChart.metrics}
            categories={revenueChart.categories}
            initialMetric={revenueChart.initial}
          />
        </div>
        <div className="col-span-12 lg:col-span-4">
          <TopProductsPanel products={panelTopProducts} projectId={projectId} />
        </div>
      </div>

      <div className="mt-4">
        <LtvDistributionCard projectId={projectId} />
      </div>

      <div className="mt-4">
        <PredictedLtvCard projectId={projectId} />
      </div>

      <div className="mt-4">
        <EngagementCard projectId={projectId} />
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-6">
          <RecentActivityPanel events={panelActivity} live projectId={projectId} />
        </div>
        <div className="col-span-12 lg:col-span-6">
          <ExperimentsPanel experiments={panelExperiments} projectId={projectId} />
        </div>
      </div>

      <div className="mt-4">
        <SystemHealthPanel services={panelHealth} />
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
