import { useTranslation } from "react-i18next";
import { Terminal } from "lucide-react";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { RAIL_ENTRIES } from "./mock-data";
import type { CategoryCounts, RailEntryId } from "./types";

type Props = {
  active: RailEntryId;
  counts: CategoryCounts;
  onSelect: (id: RailEntryId) => void;
};

export function CategoryRail({ active, counts, onSelect }: Props) {
  const { t } = useTranslation();
  return (
    <aside className="sticky top-[76px] flex flex-col gap-1 rounded-lg border border-rv-divider bg-rv-c1 p-2">
      {RAIL_ENTRIES.map((entry, idx) =>
        entry.kind === "section" ? (
          <div
            key={`section-${idx}`}
            className="px-2.5 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500"
          >
            {t(`apps.rail.sections.${entry.labelKey}`)}
          </div>
        ) : (
          <button
            key={entry.id}
            type="button"
            onClick={() => onSelect(entry.id)}
            className={cn(
              "flex h-7 items-center gap-2.5 rounded px-2.5 text-[12.5px] transition cursor-pointer",
              entry.id === active
                ? "bg-rv-accent-500/14 text-rv-accent-400"
                : "text-rv-mute-700 hover:bg-rv-c2",
            )}
          >
            <entry.icon size={13} className="shrink-0" />
            <span className="flex-1 truncate text-left">
              {t(`apps.categories.${entry.id}`)}
            </span>
            <span
              className={cn(
                "font-rv-mono text-[11px]",
                entry.id === active ? "text-rv-accent-400" : "text-rv-mute-500",
              )}
            >
              {counts[entry.id] ?? 0}
            </span>
          </button>
        ),
      )}
      <div className="mt-1.5 border-t border-rv-divider px-2.5 pb-2 pt-3">
        <p className="mb-2 text-[11px] leading-[1.55] text-rv-mute-500">
          {t("apps.rail.consoleHelp")}
        </p>
        <Button variant="flat" size="sm" className="h-7 w-full text-[11.5px]">
          <Terminal size={12} />
          {t("apps.rail.openConsole")}
        </Button>
      </div>
    </aside>
  );
}
