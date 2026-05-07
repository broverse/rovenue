import { useTranslation } from "react-i18next";
import { SearchInput } from "../../ui/search-input";
import { cn } from "../../lib/cn";
import { ProductGroupIcon } from "./product-group-icon";
import type { ProductGroup } from "./types";

type Props = {
  groups: ReadonlyArray<ProductGroup>;
  selectedId: string;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (next: string) => void;
};

/**
 * Sticky left rail listing every product group in the project. Each card
 * surfaces the icon, key, product/offering counts and MRR, with a vertical
 * accent stripe + tinted background on the active row.
 */
export function ProductGroupList({
  groups,
  selectedId,
  onSelect,
  search,
  onSearchChange,
}: Props) {
  const { t } = useTranslation();
  return (
    <aside className="sticky top-[76px] flex max-h-[calc(100vh-96px)] flex-col overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="border-b border-rv-divider p-2.5">
        <SearchInput
          value={search}
          onValueChange={onSearchChange}
          placeholder={t("productGroups.search.placeholder")}
          size="sm"
        />
      </div>

      <div className="flex-1 overflow-y-auto [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]">
        {groups.map((g) => (
          <ProductGroupCard
            key={g.id}
            group={g}
            active={g.id === selectedId}
            onClick={() => onSelect(g.id)}
          />
        ))}
        {groups.length === 0 && (
          <div className="px-3 py-8 text-center font-rv-mono text-[11px] text-rv-mute-500">
            {t("productGroups.search.empty")}
          </div>
        )}
      </div>
    </aside>
  );
}

type CardProps = {
  group: ProductGroup;
  active: boolean;
  onClick: () => void;
};

function ProductGroupCard({ group, active, onClick }: CardProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative block w-full cursor-pointer border-b border-white/5 px-3.5 py-3 text-left transition hover:bg-rv-c2",
        active && "bg-rv-accent-500/10",
      )}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-0.5 bg-rv-accent-500"
        />
      )}
      <div className="mb-2 flex items-center gap-2.5">
        <ProductGroupIcon initials={group.initials} tint={group.tint} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-foreground">{group.name}</div>
          <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">{group.key}</div>
        </div>
      </div>
      <div className="flex items-center gap-3 font-rv-mono text-[11px] text-rv-mute-500">
        <span>
          <span className="text-rv-mute-800">{group.products.length}</span>{" "}
          {t("productGroups.card.products")}
        </span>
        <span>
          <span className="text-rv-mute-800">{group.offerings.length}</span>{" "}
          {t("productGroups.card.offerings")}
        </span>
        <span className="ml-auto">
          ${group.mrr.toLocaleString()}
          <span className="text-rv-mute-400">{t("productGroups.card.perMonth")}</span>
        </span>
      </div>
    </button>
  );
}
