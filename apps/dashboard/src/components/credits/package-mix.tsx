import { useTranslation } from "react-i18next";
import type { CreditPack } from "./types";

type PackageMixProps = {
  packs?: ReadonlyArray<CreditPack>;
};

/**
 * Package-mix card — top-N credit packs sold in the last 28 days, with
 * a thin pack-color rail under each row encoding share. The header sub
 * shows the running total of units sold across all packs.
 */
export function PackageMix({ packs }: PackageMixProps = {}) {
  const { t } = useTranslation();
  const data = packs ?? [];
  const totalSold = data.reduce((sum, pack) => sum + pack.sold, 0);

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <header className="mb-3.5 flex items-center justify-between text-[13px] font-semibold">
        <span>{t("credits.packs.title")}</span>
        <span className="font-rv-mono text-[11px] font-normal text-rv-mute-500">
          {t("credits.packs.sold", { count: totalSold.toLocaleString() })}
        </span>
      </header>
      {data.length === 0 ? (
        <div className="py-6 text-center font-rv-mono text-[12px] text-rv-mute-500">
          {t("credits.packs.empty")}
        </div>
      ) : (
      <div className="flex flex-col">
        {data.map((pack) => (
          <div
            key={pack.id}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-2.5 border-b border-white/[0.05] py-2.5 last:border-none"
          >
            <div className="min-w-0">
              <div className="font-rv-mono text-[12px]">{pack.name}</div>
              <div className="mt-0.5 text-[11px] text-rv-mute-500">
                {t("credits.packs.unitsSold", {
                  count: pack.sold.toLocaleString(),
                })}
              </div>
            </div>
            <div className="font-rv-mono text-[12px]">
              {pack.price === 0 ? t("credits.packs.free") : `$${pack.price}`}
            </div>
            <div className="text-right font-rv-mono text-[10px] text-rv-mute-500">
              {pack.share}%
            </div>
            <div className="col-span-3 mt-1.5 h-1 overflow-hidden rounded-sm bg-rv-c3">
              <div
                className="h-full rounded-sm"
                style={{ width: `${pack.share}%`, background: pack.color }}
              />
            </div>
          </div>
        ))}
      </div>
      )}
    </section>
  );
}
