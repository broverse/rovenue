import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LineChart, Star, Trash2 } from "lucide-react";
import type { ChartCatalogEntry, ChartCategory } from "@rovenue/shared";
import { SearchInput } from "../../ui/search-input";
import { cn } from "../../lib/cn";

// Category render order mirrors the original hard-coded library —
// "custom" floats to the bottom so user-authored charts don't
// obscure the system defaults.
const CATEGORY_ORDER: ReadonlyArray<ChartCategory> = [
  "revenue",
  "growth",
  "retention",
  "conversion",
  "credits",
  "custom",
];

type Props = {
  entries: ReadonlyArray<ChartCatalogEntry>;
  selectedId: string;
  starredIds: ReadonlySet<string>;
  onSelect: (next: string) => void;
  onDelete?: (entry: ChartCatalogEntry) => void;
  loading?: boolean;
};

/**
 * Resolve a catalog entry's display label. System entries carry
 * a translation slug; custom entries use the user-provided name
 * verbatim so we don't try to translate "MyChart".
 */
function entryLabel(
  entry: ChartCatalogEntry,
  t: (key: string) => string,
): string {
  if (entry.kind === "system") return t(`charts.items.${entry.id}`);
  return entry.name;
}

export function ChartCatalog({
  entries,
  selectedId,
  starredIds,
  onSelect,
  onDelete,
  loading,
}: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matches = (entry: ChartCatalogEntry) => {
      if (!term) return true;
      return entryLabel(entry, t).toLowerCase().includes(term);
    };
    return CATEGORY_ORDER.map((category) => ({
      category,
      items: entries.filter(
        (entry) => entry.category === category && matches(entry),
      ),
    })).filter((group) => group.items.length > 0);
  }, [entries, query, t]);

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
            {group.items.map((entry) => {
              const active = entry.id === selectedId;
              const starred = starredIds.has(entry.id);
              const deletable = entry.kind === "custom";
              return (
                <div
                  key={entry.id}
                  className={cn(
                    "group flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition",
                    active
                      ? "bg-rv-accent-500/14 text-rv-accent-400"
                      : "text-rv-mute-700 hover:bg-rv-c2",
                  )}
                  onClick={() => onSelect(entry.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(entry.id);
                    }
                  }}
                >
                  <LineChart size={12} className="shrink-0" />
                  <span className="flex-1 truncate">
                    {entryLabel(entry, t)}
                  </span>
                  {starred && (
                    <Star
                      size={11}
                      className="shrink-0 fill-rv-warning text-rv-warning"
                    />
                  )}
                  {deletable && onDelete && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(entry);
                      }}
                      aria-label={t("charts.catalog.delete")}
                      className="hidden shrink-0 cursor-pointer rounded p-0.5 text-rv-mute-500 transition hover:bg-rv-c3 hover:text-rv-danger group-hover:inline-flex"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {grouped.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-rv-mute-500">
            {loading
              ? t("charts.catalog.loading")
              : t("charts.catalog.empty")}
          </div>
        )}
      </div>
    </aside>
  );
}
