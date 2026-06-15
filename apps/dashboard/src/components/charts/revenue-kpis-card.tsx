import { useTranslation } from "react-i18next";
import { useProjectRevenueSummary } from "../../lib/hooks/useProjectRevenueSummary";
import { formatCurrencyCompact } from "./format";

type Props = {
  projectId: string;
};

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div className="mt-1 font-rv-mono text-[18px] font-medium tabular-nums">
        {value}
      </div>
    </div>
  );
}

export function RevenueKpisCard({ projectId }: Props) {
  const { t } = useTranslation();
  const { data, isLoading } = useProjectRevenueSummary({ projectId });

  const dash = "—";
  const money = (v?: string | null) =>
    isLoading || v == null ? dash : formatCurrencyCompact(Number(v));
  const pct = (v?: number | null) =>
    isLoading || v == null ? dash : `${(v * 100).toFixed(1)}%`;

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3.5 font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
        {t("charts.revenueKpis.title")}
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-3">
        <Kpi label={t("charts.revenueKpis.netRevenue")} value={money(data?.netUsd)} />
        <Kpi label={t("charts.revenueKpis.refunds")} value={money(data?.refundsUsd)} />
        <Kpi label={t("charts.revenueKpis.refundRate")} value={pct(data?.refundRate)} />
        <Kpi label={t("charts.revenueKpis.arppu")} value={money(data?.arppu)} />
        <Kpi label={t("charts.revenueKpis.avgLtv")} value={money(data?.avgLtvUsd)} />
        <Kpi label={t("charts.revenueKpis.medianLtv")} value={money(data?.medianLtvUsd)} />
        <Kpi label={t("charts.revenueKpis.arpu")} value={money(data?.arpu)} />
        <Kpi label={t("charts.revenueKpis.churnRate")} value={pct(data?.churnRate)} />
        <Kpi label={t("charts.revenueKpis.trialToPaid")} value={pct(data?.trialConversionRate)} />
      </div>
    </section>
  );
}
