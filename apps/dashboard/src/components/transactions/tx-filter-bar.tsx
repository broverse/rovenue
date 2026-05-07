import { Plus, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FilterPill } from "../subscribers/filter-pill";

type Props = {
  search: string;
  onSearchChange: (next: string) => void;
  visible: number;
  total: number;
};

/**
 * Filter bar above the transactions table. The search field, dashed
 * "Add filter" button, and the right-aligned `visible / total` counter
 * mirror the same row on the subscribers page so the two pages feel
 * like siblings.
 */
export function TxFilterBar({ search, onSearchChange, visible, total }: Props) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-rv-divider bg-rv-c1 px-3 py-2.5">
      <label className="flex h-[26px] min-w-[260px] flex-1 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 transition focus-within:border-rv-accent-500">
        <Search size={12} className="text-rv-mute-500" />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("transactions.filters.searchPlaceholder")}
          className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
        />
      </label>

      <FilterPill active>
        {t("transactions.filters.amount")}{" "}
        <span className="font-medium text-foreground">{t("transactions.filters.amountValue")}</span>
        <X size={10} />
      </FilterPill>
      <FilterPill>
        {t("transactions.filters.store")}{" "}
        <span className="font-medium text-foreground">{t("transactions.filters.any")}</span>
      </FilterPill>
      <FilterPill>
        {t("transactions.filters.currency")}{" "}
        <span className="font-medium text-foreground">USD</span>
      </FilterPill>
      <FilterPill>
        {t("transactions.filters.country")}{" "}
        <span className="font-medium text-foreground">{t("transactions.filters.any")}</span>
      </FilterPill>
      <FilterPill>
        <Plus size={10} />
        {t("transactions.filters.addFilter")}
      </FilterPill>

      <span className="ml-auto font-rv-mono text-[12px] text-rv-mute-500">
        {t("transactions.filters.showing", {
          visible: visible.toLocaleString(),
          total: total.toLocaleString(),
        })}
      </span>
    </div>
  );
}
