import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { DashboardAccessRow } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { SearchInput } from "../../ui/search-input";
import { cn } from "../../lib/cn";

type Props = {
  rows: ReadonlyArray<DashboardAccessRow>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (next: string) => void;
  onCreate: () => void;
};

/**
 * Sticky left rail listing every access row in the project. Search
 * filters across both `displayName` and `identifier`. Selected row is
 * highlighted with a vertical accent stripe and tinted background;
 * empty state surfaces a primary "Create access" CTA.
 */
export function AccessList({
  rows,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  onCreate,
}: Props) {
  const { t } = useTranslation();
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.displayName.toLowerCase().includes(q) ||
        r.identifier.toLowerCase().includes(q),
    );
  }, [rows, search]);

  return (
    <aside className="sticky top-[76px] flex max-h-[calc(100vh-96px)] flex-col overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="border-b border-rv-divider p-2.5">
        <SearchInput
          value={search}
          onValueChange={onSearchChange}
          placeholder={t("access.search.placeholder", "Search access…")}
          size="sm"
        />
      </div>

      <div className="flex-1 overflow-y-auto [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]">
        {filtered.map((row) => (
          <AccessRowCard
            key={row.id}
            row={row}
            active={row.id === selectedId}
            onClick={() => onSelect(row.id)}
          />
        ))}
        {rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <p className="font-rv-mono text-[11px] text-rv-mute-500">
              {t("access.empty.title", "No access defined yet.")}
            </p>
            <Button
              type="button"
              variant="solid-primary"
              size="sm"
              onClick={onCreate}
            >
              <Plus size={13} />
              {t("access.empty.cta", "Create access")}
            </Button>
          </div>
        )}
        {rows.length > 0 && filtered.length === 0 && (
          <div className="px-3 py-8 text-center font-rv-mono text-[11px] text-rv-mute-500">
            {t("access.search.empty", "No access matches your search.")}
          </div>
        )}
      </div>
    </aside>
  );
}

type CardProps = {
  row: DashboardAccessRow;
  active: boolean;
  onClick: () => void;
};

function AccessRowCard({ row, active, onClick }: CardProps) {
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
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-foreground">
          {row.displayName}
        </div>
        <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">
          {row.identifier}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 font-rv-mono text-[11px] text-rv-mute-500">
        <span>
          <span className="text-rv-mute-800">{row.productCount}</span>{" "}
          {t("access.card.products", "products")}
        </span>
      </div>
    </button>
  );
}
