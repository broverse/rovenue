import { useTranslation } from "react-i18next";
import { LayoutGrid, List } from "lucide-react";
import { SearchInput } from "../../ui/search-input";
import { cn } from "../../lib/cn";
import type { AppTier, AppView } from "./types";

type Props = {
  query: string;
  onQueryChange: (next: string) => void;
  view: AppView;
  onViewChange: (next: AppView) => void;
  tier: AppTier;
  onTierChange: (next: AppTier) => void;
};

const TIERS: ReadonlyArray<AppTier> = ["all", "official", "partner", "self-hosted"];

export function AppsToolbar({
  query,
  onQueryChange,
  view,
  onViewChange,
  tier,
  onTierChange,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="mb-3.5 flex flex-wrap items-center gap-2.5 rounded-lg border border-rv-divider bg-rv-c1 px-3.5 py-2.5">
      <SearchInput
        value={query}
        onValueChange={onQueryChange}
        placeholder={t("apps.toolbar.searchPlaceholder")}
        aria-label={t("apps.toolbar.searchAria")}
        size="md"
        rootClassName="min-w-[220px] flex-1"
      />
      <div className="inline-flex items-center gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5">
        {(["grid", "list"] as const).map((option) => {
          const Icon = option === "grid" ? LayoutGrid : List;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onViewChange(option)}
              className={cn(
                "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded px-2.5 text-[11.5px] transition",
                view === option
                  ? "bg-rv-c4 text-foreground"
                  : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              <Icon size={11} />
              {t(`apps.toolbar.view.${option}`)}
            </button>
          );
        })}
      </div>
      <div className="inline-flex items-center gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5">
        {TIERS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onTierChange(option)}
            className={cn(
              "inline-flex h-[26px] cursor-pointer items-center rounded px-2.5 text-[11.5px] transition",
              tier === option
                ? "bg-rv-c4 text-foreground"
                : "text-rv-mute-600 hover:text-foreground",
            )}
          >
            {t(`apps.toolbar.tiers.${tierKey(option)}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function tierKey(tier: AppTier): string {
  return tier === "self-hosted" ? "selfHosted" : tier;
}
