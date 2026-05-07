import { AlertTriangle, Check, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { BILLING_ISSUES } from "./mock-data";
import type { IssueSeverity } from "./types";

const ICON_TONE: Record<IssueSeverity, string> = {
  high: "bg-rv-danger/15 text-rv-danger border-rv-danger/25",
  medium: "bg-rv-warning/15 text-rv-warning border-rv-warning/25",
  low: "bg-rv-warning/15 text-rv-warning border-rv-warning/25",
  resolved: "bg-rv-success/15 text-rv-success border-rv-success/25",
};

const NEXT_TONE: Record<IssueSeverity, string> = {
  high: "text-rv-danger",
  medium: "text-rv-warning",
  low: "text-rv-warning",
  resolved: "text-rv-success",
};

export function BillingIssuesPanel() {
  const { t } = useTranslation();
  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-baseline justify-between border-b border-rv-divider px-4 py-3.5">
        <div>
          <h3 className="text-[14px] font-semibold">
            {t("subscriptions.billingIssues.title")}
          </h3>
          <p className="mt-0.5 text-[12px] text-rv-mute-500">
            {t("subscriptions.billingIssues.subtitle")}
          </p>
        </div>
        <Button variant="light" size="sm">
          {t("subscriptions.billingIssues.viewAll")}
          <ChevronRight size={12} />
        </Button>
      </header>

      <ul>
        {BILLING_ISSUES.map((i) => (
          <li
            key={`${i.id}-${i.issue}`}
            className="grid cursor-pointer items-center gap-3 border-b border-white/[0.04] px-4 py-3 transition last:border-b-0 hover:bg-rv-c2 grid-cols-[auto_1fr_auto_auto]"
          >
            <span
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-md border",
                ICON_TONE[i.severity],
              )}
            >
              {i.severity === "resolved" ? (
                <Check size={13} />
              ) : (
                <AlertTriangle size={13} />
              )}
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-foreground">
                {i.issue}
              </div>
              <div className="mt-0.5 truncate font-rv-mono text-[11px] text-rv-mute-500">
                {i.user} · {i.product} ·{" "}
                {t("subscriptions.billingIssues.attempt", {
                  count: i.attempts,
                })}
              </div>
            </div>
            <div
              className={cn(
                "text-right font-rv-mono text-[12px] tabular-nums",
                i.severity === "resolved" ? "text-rv-mute-500" : "text-foreground",
              )}
            >
              ${i.mrr.toFixed(2)}
              <span className="text-rv-mute-500">/mo</span>
            </div>
            <div
              className={cn(
                "min-w-[110px] text-right font-rv-mono text-[11px]",
                NEXT_TONE[i.severity],
              )}
            >
              {i.next}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
