import { useTranslation } from "react-i18next";
import { SearchInput } from "../../ui/search-input";
import { cn } from "../../lib/cn";
import { OfferingIcon } from "./offering-icon";
import type { Offering } from "./types";

type Props = {
  offerings: ReadonlyArray<Offering>;
  selectedId: string;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (next: string) => void;
};

/**
 * Sticky left rail listing every offering in the project. Each card
 * surfaces the icon, key, product count and MRR, with a vertical
 * accent stripe + tinted background on the active row.
 */
export function OfferingList({
  offerings,
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
          placeholder={t("offerings.search.placeholder")}
          size="sm"
        />
      </div>

      <div className="flex-1 overflow-y-auto [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]">
        {offerings.map((o) => (
          <OfferingCard
            key={o.id}
            offering={o}
            active={o.id === selectedId}
            onClick={() => onSelect(o.id)}
          />
        ))}
        {offerings.length === 0 && (
          <div className="px-3 py-8 text-center font-rv-mono text-[11px] text-rv-mute-500">
            {t("offerings.search.empty")}
          </div>
        )}
      </div>
    </aside>
  );
}

type CardProps = {
  offering: Offering;
  active: boolean;
  onClick: () => void;
};

function OfferingCard({ offering, active, onClick }: CardProps) {
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
        <OfferingIcon initials={offering.initials} tint={offering.tint} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-foreground">{offering.name}</div>
          <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">{offering.key}</div>
        </div>
      </div>
      <div className="flex items-center gap-3 font-rv-mono text-[11px] text-rv-mute-500">
        <span>
          <span className="text-rv-mute-800">{offering.products.length}</span>{" "}
          {t("offerings.card.products")}
        </span>
        {offering.isDefault && (
          <span className="rounded-sm bg-rv-accent-500/15 px-1.5 py-px text-[10px] uppercase tracking-wider text-rv-accent-500">
            {t("offerings.card.default", "Default")}
          </span>
        )}
        <span className="ml-auto">
          ${offering.mrr.toLocaleString()}
          <span className="text-rv-mute-400">{t("offerings.card.perMonth")}</span>
        </span>
      </div>
    </button>
  );
}
