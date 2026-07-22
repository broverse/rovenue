import { useTranslation } from "react-i18next";
import { Eye, ShoppingCart, Users } from "lucide-react";
import { usePlacementMetrics } from "../../lib/hooks/useProjectPlacements";

type Props = {
  projectId: string;
  placementId: string;
};

/**
 * Views / unique views / purchases / CR for one placement, backed by
 * `GET /dashboard/projects/:projectId/placements/:id/metrics`
 * (mv_paywall_daily_target + a query-time purchase join — see
 * apps/api/src/services/placement-metrics.ts). The endpoint always
 * resolves (all-zero when ClickHouse is unconfigured), so this card
 * never needs an "analytics unavailable" branch — just a loading one.
 */
export function PlacementMetricsCard({ projectId, placementId }: Props) {
  const { t } = useTranslation();
  const { data, isPending } = usePlacementMetrics(projectId, placementId);

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1">
      <header className="border-b border-rv-divider px-5 py-3">
        <h3 className="text-[13px] font-medium text-foreground">
          {t("placements.metrics.title", "Performance")}
        </h3>
      </header>
      <div className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4">
        <Stat
          icon={<Eye size={13} />}
          label={t("placements.metrics.views", "Views")}
          value={isPending ? "—" : formatCount(data?.views ?? 0)}
        />
        <Stat
          icon={<Users size={13} />}
          label={t("placements.metrics.uniqueViews", "Unique views")}
          value={isPending ? "—" : formatCount(data?.uniqueViews ?? 0)}
        />
        <Stat
          icon={<ShoppingCart size={13} />}
          label={t("placements.metrics.purchases", "Purchases")}
          value={isPending ? "—" : formatCount(data?.purchases ?? 0)}
        />
        <Stat
          // Precise attribution since CH migration 0019: purchases are
          // counted from raw_revenue_events.placementId (presentedContext),
          // not a viewer-overlap heuristic. Pre-0019 revenue rows carry no
          // placement and are simply not counted.
          label={t("placements.metrics.conversionRate", "Conversion rate")}
          value={
            isPending
              ? "—"
              : data?.conversionRate === null || data?.conversionRate === undefined
                ? "—"
                : `${(data.conversionRate * 100).toFixed(1)}%`
          }
        />
      </div>
    </section>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] text-rv-mute-500">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-rv-mono text-[18px] font-semibold tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
