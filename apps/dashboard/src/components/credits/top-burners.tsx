import { useTranslation } from "react-i18next";
import { BURNERS } from "./mock-data";
import type { CreditBurner } from "./types";

type TopBurnersProps = {
  burners?: ReadonlyArray<CreditBurner>;
};

/**
 * Top-burners card — ranks features by credits burned over the last
 * 28 days. Useful for spotting whether a single endpoint dominates
 * burn (and therefore is the lever for unit-economics).
 */
export function TopBurners({ burners }: TopBurnersProps = {}) {
  const { t } = useTranslation();
  const data = burners && burners.length > 0 ? burners : BURNERS;
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <header className="mb-3.5 flex items-center justify-between text-[13px] font-semibold">
        <span>{t("credits.burners.title")}</span>
        <span className="font-rv-mono text-[11px] font-normal text-rv-mute-500">
          {t("credits.burners.sub")}
        </span>
      </header>
      <div>
        {data.map((burner) => (
          <div
            key={burner.id}
            className="grid grid-cols-[1fr_auto] items-center gap-2 border-b border-white/[0.04] py-2 last:border-none"
          >
            <div className="min-w-0">
              <div className="font-rv-mono text-[12px]">{burner.feature}</div>
              <div className="mt-0.5 text-[11px] text-rv-mute-500">
                {burner.description} · {burner.cost}
              </div>
            </div>
            <div className="text-right font-rv-mono tabular-nums">
              <div className="text-[12px]">{burner.burnedM}M</div>
              <div className="mt-0.5 text-[10px] text-rv-mute-500">{burner.pct}%</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
