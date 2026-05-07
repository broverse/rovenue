import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LineChart, Star } from "lucide-react";
import { SearchInput } from "../../ui/search-input";
import { cn } from "../../lib/cn";
import { CHART_CATALOG } from "./mock-data";
import type { ChartCategory, ChartDescriptor } from "./types";

const CATEGORY_ORDER: ReadonlyArray<ChartCategory> = [
  "revenue",
  "growth",
  "retention",
  "conversion",
  "credits",
];

type Props = {
  selectedId: string;
  onSelect: (next: string) => void;
};

export function ChartCatalog({ selectedId, onSelect }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matches = (chart: ChartDescriptor) => {
      if (!term) return true;
      return t(`charts.items.${chart.id}`).toLowerCase().includes(term);
    };
    return CATEGORY_ORDER.map((category) => ({
      category,
      items: CHART_CATALOG.filter(
        (chart) => chart.category === category && matches(chart),
      ),
    })).filter((group) => group.items.length > 0);
  }, [query, t]);

  return (
    <aside className="sticky top-[76px] flex max-h-[calc(100vh-96px)] flex-col overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="border-b border-rv-divider p-2.5">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("charts.catalog.searchPlaceholder")}
          aria-label={t("charts.catalog.searchAria")}
          size="sm"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {grouped.map((group) => (
          <div key={group.category}>
            <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
              {t(`charts.categories.${group.category}`)}
            </div>
            {group.items.map((chart) => {
              const active = chart.id === selectedId;
              return (
                <button
                  key={chart.id}
                  type="button"
                  onClick={() => onSelect(chart.id)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition",
                    active
                      ? "bg-rv-accent-500/14 text-rv-accent-400"
                      : "text-rv-mute-700 hover:bg-rv-c2",
                  )}
                >
                  <LineChart size={12} className="shrink-0" />
                  <span className="flex-1 truncate">
                    {t(`charts.items.${chart.id}`)}
                  </span>
                  {chart.star && (
                    <Star
                      size={11}
                      className="shrink-0 fill-rv-warning text-rv-warning"
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
        {grouped.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-rv-mute-500">
            {t("charts.catalog.empty")}
          </div>
        )}
      </div>
    </aside>
  );
}
