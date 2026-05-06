import { useTranslation } from "react-i18next";
import { Card, CardHeader } from "../../ui/card";
import { Button } from "../../ui/button";

export type TopProduct = {
  name: string;
  sku: string;
  rev: number;
  pct: number;
  subs: number;
};

type Props = { products: ReadonlyArray<TopProduct> };

/**
 * "Top products" panel — revenue contribution as labeled progress rows.
 */
export function TopProductsPanel({ products }: Props) {
  const { t } = useTranslation();
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={t("panels.topProducts.title")}
        subtitle={t("panels.topProducts.subtitle")}
        right={
          <Button variant="light" className="h-6 px-2 text-xs">
            {t("panels.topProducts.viewAll")}
          </Button>
        }
      />
      <div className="flex-1 px-5 pb-4 pt-1">
        {products.map((p) => (
          <div
            key={p.sku}
            className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 border-b border-rv-divider py-2.5 last:border-b-0"
          >
            <div className="text-[13px] font-medium text-rv-mute-800">{p.name}</div>
            <div className="font-rv-mono text-[13px] tabular-nums">${p.rev.toLocaleString()}</div>
            <div className="col-span-full flex items-center gap-2 font-rv-mono text-[11px] text-rv-mute-500">
              <code className="rounded border border-rv-divider bg-rv-c4 px-1.5 py-0.5 text-[10px] text-rv-mute-700">
                {p.sku}
              </code>
              <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-rv-accent-500/12">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-rv-accent-500 transition-[width] duration-500 ease-out"
                  style={{ width: `${p.pct}%` }}
                />
              </span>
              <span className="min-w-9 text-right">{p.pct}%</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
