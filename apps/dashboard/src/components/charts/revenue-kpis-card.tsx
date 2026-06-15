import { useTranslation } from "react-i18next";
import { useProjectRevenueSummary } from "../../lib/hooks/useProjectRevenueSummary";
import { fmtMoney, fmtPct } from "./format";
import { KpiTile } from "./kpi-tile";

type Props = {
  projectId: string;
};

export function RevenueKpisCard({ projectId }: Props) {
  const { t } = useTranslation();
  const { data, isLoading } = useProjectRevenueSummary({ projectId });

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="mb-3.5 font-rv-mono text-[11px] uppercase tracking-wider text-rv-mute-500">
        {t("charts.revenueKpis.title")}
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-3">
        <KpiTile label={t("charts.revenueKpis.netRevenue")} value={fmtMoney(data?.netUsd, isLoading)} />
        <KpiTile label={t("charts.revenueKpis.refunds")} value={fmtMoney(data?.refundsUsd, isLoading)} />
        <KpiTile label={t("charts.revenueKpis.refundRate")} value={fmtPct(data?.refundRate, isLoading)} />
        <KpiTile label={t("charts.revenueKpis.arppu")} value={fmtMoney(data?.arppu, isLoading)} />
        <KpiTile label={t("charts.revenueKpis.avgLtv")} value={fmtMoney(data?.avgLtvUsd, isLoading)} />
        <KpiTile label={t("charts.revenueKpis.medianLtv")} value={fmtMoney(data?.medianLtvUsd, isLoading)} />
        <KpiTile label={t("charts.revenueKpis.arpu")} value={fmtMoney(data?.arpu, isLoading)} />
        <KpiTile label={t("charts.revenueKpis.churnRate")} value={fmtPct(data?.churnRate, isLoading)} />
        <KpiTile label={t("charts.revenueKpis.trialToPaid")} value={fmtPct(data?.trialConversionRate, isLoading)} />
      </div>
    </section>
  );
}
