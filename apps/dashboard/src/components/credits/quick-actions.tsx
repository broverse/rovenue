import { ArrowDownUp, Coins, RefreshCw, Webhook } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";

/**
 * Right-rail quick actions — bulk-grant CSV, expiry policy, manual
 * reconciliation, and breakage report. Buttons are flat and aligned
 * to the start so the icons line up regardless of label length.
 */
export function QuickActions() {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <h3 className="mb-3.5 text-[13px] font-semibold">{t("credits.quickActions.title")}</h3>
      <div className="flex flex-col gap-2">
        <Button variant="flat" size="sm" className="justify-start">
          <Coins size={13} />
          {t("credits.quickActions.bulkGrant")}
        </Button>
        <Button variant="flat" size="sm" className="justify-start">
          <ArrowDownUp size={13} />
          {t("credits.quickActions.expiryPolicy")}
        </Button>
        <Button variant="flat" size="sm" className="justify-start">
          <RefreshCw size={13} />
          {t("credits.quickActions.reconcile")}
        </Button>
        <Button variant="flat" size="sm" className="justify-start">
          <Webhook size={13} />
          {t("credits.quickActions.breakageReport")}
        </Button>
      </div>
    </section>
  );
}
