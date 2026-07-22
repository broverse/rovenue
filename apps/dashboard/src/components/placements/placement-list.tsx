import { useTranslation } from "react-i18next";
import { SearchInput } from "../../ui/search-input";
import { cn } from "../../lib/cn";
import type { Placement } from "./types";

type Props = {
  placements: ReadonlyArray<Placement>;
  selectedId: string;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (next: string) => void;
};

/**
 * Sticky left rail listing every placement in the project. Mirrors
 * paywall-list.tsx: identifier + name, row count and active state
 * surfaced under each entry.
 */
export function PlacementList({ placements, selectedId, onSelect, search, onSearchChange }: Props) {
  const { t } = useTranslation();
  return (
    <aside className="sticky top-[76px] flex max-h-[calc(100vh-96px)] flex-col overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="border-b border-rv-divider p-2.5">
        <SearchInput
          value={search}
          onValueChange={onSearchChange}
          placeholder={t("placements.search.placeholder", "Search placements…")}
          size="sm"
        />
      </div>

      <div className="flex-1 overflow-y-auto [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]">
        {placements.map((p) => (
          <PlacementCard
            key={p.id}
            placement={p}
            active={p.id === selectedId}
            onClick={() => onSelect(p.id)}
          />
        ))}
        {placements.length === 0 && (
          <div className="px-3 py-8 text-center font-rv-mono text-[11px] text-rv-mute-500">
            {t("placements.search.empty", "No placements match")}
          </div>
        )}
      </div>
    </aside>
  );
}

function PlacementCard({
  placement,
  active,
  onClick,
}: {
  placement: Placement;
  active: boolean;
  onClick: () => void;
}) {
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
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-rv-accent-500" />
      )}
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
          {placement.name}
        </span>
        {!placement.isActive && (
          <span className="shrink-0 rounded-sm bg-rv-c3 px-1.5 py-px font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
            {t("placements.card.inactive", "Inactive")}
          </span>
        )}
      </div>
      <div className="font-rv-mono text-[11px] text-rv-mute-500">{placement.identifier}</div>
      <div className="mt-1 truncate font-rv-mono text-[10px] text-rv-mute-400">
        {t("placements.card.rows", { defaultValue: "{{n}} rows · rev {{rev}}", n: placement.rows.length, rev: placement.revision })}
      </div>
    </button>
  );
}
