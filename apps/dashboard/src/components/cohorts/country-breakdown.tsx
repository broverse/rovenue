import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { COUNTRY_BREAKDOWN } from "./mock-data";

export function CountryBreakdown() {
  const { t } = useTranslation();
  const cols = "grid-cols-[1fr_80px_80px_80px_80px_80px]";

  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="border-b border-rv-divider px-4 py-3.5">
        <h3 className="text-[14px] font-semibold">{t("cohorts.breakdown.title")}</h3>
        <p className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">
          {t("cohorts.breakdown.subtitle")}
        </p>
      </header>

      <div>
        <div
          className={cn(
            "grid items-center gap-3 border-b border-t border-rv-divider bg-rv-c2 px-3.5 py-2.5",
            "text-[10px] font-medium uppercase tracking-wider text-rv-mute-500",
            cols,
          )}
        >
          <div>{t("cohorts.breakdown.cols.country")}</div>
          <div className="text-right">{t("cohorts.breakdown.cols.users")}</div>
          <div className="text-right">{t("cohorts.breakdown.cols.w4")}</div>
          <div className="text-right">{t("cohorts.breakdown.cols.ltv")}</div>
          <div className="text-right">{t("cohorts.breakdown.cols.churn")}</div>
          <div className="text-right">{t("cohorts.breakdown.cols.vsAvg")}</div>
        </div>

        {COUNTRY_BREAKDOWN.map((row) => {
          const negative = row.delta.startsWith("−");
          return (
            <div
              key={row.country}
              className={cn(
                "grid items-center gap-3 border-b border-rv-divider px-3.5 py-2.5 text-[12px] last:border-b-0",
                cols,
              )}
            >
              <div className="text-foreground">{row.country}</div>
              <div className="text-right font-rv-mono tabular-nums">
                {row.users.toLocaleString()}
              </div>
              <div className="text-right font-rv-mono tabular-nums">{row.w4}%</div>
              <div className="text-right font-rv-mono tabular-nums">
                ${row.ltv.toFixed(2)}
              </div>
              <div className="text-right font-rv-mono tabular-nums">{row.churn}%</div>
              <div
                className={cn(
                  "text-right font-rv-mono tabular-nums",
                  negative ? "text-rv-danger" : "text-rv-success",
                )}
              >
                {row.delta}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
