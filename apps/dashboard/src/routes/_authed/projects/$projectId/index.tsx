import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { useProject } from "../../../../lib/hooks/useProject";
import { useProjectMrr } from "../../../../lib/hooks/useProjectMrr";
import { useProjectOverview } from "../../../../lib/hooks/useProjectOverview";
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
import type {
  ActivityEvent,
  ActivityKind,
  HealthService,
  TopProduct,
} from "../../../../components/dashboard";
import type {
  OverviewActivityEvent,
  OverviewSystemHealth,
  OverviewTopProduct,
  RevenueEventTypeName,
} from "@rovenue/shared";

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

/**
 * Net-churn is inverted for KPI presentation: lower is better, so
 * a positive Δpp renders as danger and negative as success.
 */
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
  // The panel renders short identifiers; trim long uuids/cuids to
  // an 8-char display. Avoids a layout shift between mock + real
  // events.
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
  const { data: overview } = useProjectOverview({ projectId });
  const [events, setEvents] = useState<ActivityEvent[]>(() => genActivity(10));
  const [now, setNow] = useState<number>(() => Date.now());

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
  }, [mrr, overview]);

  const activeSubsCard = useMemo(() => {
    const k = overview?.kpis.activeSubscribers;
    if (!k) {
      return {
        value: "2,431",
        delta: "184",
        deltaKind: "success" as const,
        sparkData: activeSeries,
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
        value: "42.8",
        unit: "%",
        delta: "1.1pp",
        deltaKind: "danger" as const,
        sparkData: trialSeries,
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
        value: "-3.2",
        unit: "%",
        delta: t("overview.kpi.improved"),
        deltaKind: "success" as const,
        sparkData: churnSeries,
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
  }, [overview, t]);

  // -------- Panels --------

  const realActivity = useMemo<ActivityEvent[] | null>(() => {
    if (!overview || overview.recentActivity.length === 0) return null;
    return toPanelActivity(overview.recentActivity, now);
  }, [overview, now]);

  const panelTopProducts = useMemo<ReadonlyArray<TopProduct>>(() => {
    if (!overview || overview.topProducts.length === 0) return topProducts;
    return toPanelTopProducts(overview.topProducts);
  }, [overview]);

  const panelHealth = useMemo<ReadonlyArray<HealthService>>(() => {
    if (!overview || overview.systemHealth.length === 0) return healthServices;
    return toPanelSystemHealth(overview.systemHealth);
  }, [overview]);

  // Live ticker — when real activity is available, age the
  // existing rows and roll the real list back in periodically so
  // the panel still feels alive. The mock-row drop continues when
  // we're still on mock data (e.g. before the first fetch lands or
  // the project has no events yet).
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      if (realActivity) {
        setEvents(realActivity);
        return;
      }
      setEvents((prev) => {
        const aged: ActivityEvent[] = prev.map((e) => ({
          ...e,
          secondsAgo: e.secondsAgo + 4,
          isNew: false,
        }));
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
  }, [realActivity]);

  useEffect(() => {
    if (realActivity) setEvents(realActivity);
  }, [realActivity]);

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

      <div className="mt-4 grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8">
          <RevenueChartPanel metrics={revenueMetrics} categories={categories} initialMetric="MRR" />
        </div>
        <div className="col-span-12 lg:col-span-4">
          <TopProductsPanel products={panelTopProducts} />
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
