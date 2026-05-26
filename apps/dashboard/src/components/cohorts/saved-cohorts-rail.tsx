import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search } from "lucide-react";
import type { CohortRow } from "@rovenue/shared";
import { cn } from "../../lib/cn";
import { dotColorForId } from "./format";

type Props = {
  cohorts: ReadonlyArray<CohortRow>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
};

export function SavedCohortsRail({
  cohorts,
  selectedId,
  onSelect,
  onNew,
}: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");

  const filtered = useMemo<ReadonlyArray<CohortRow>>(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return cohorts;
    return cohorts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description ?? "").toLowerCase().includes(q),
    );
  }, [cohorts, filter]);

  return (
    <aside className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-center justify-between border-b border-rv-divider px-3.5 py-3">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("cohorts.saved.heading")}
        </h4>
        <button
          type="button"
          aria-label={t("cohorts.saved.newAria")}
          onClick={onNew}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground"
        >
          <Plus size={12} />
        </button>
      </header>

      <div className="border-b border-rv-divider px-2.5 py-2">
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 transition focus-within:border-rv-accent-500">
          <Search size={12} className="text-rv-mute-500" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("cohorts.saved.filterPlaceholder")}
            className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
          />
        </label>
      </div>

      {filtered.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[12px] text-rv-mute-500">
          {cohorts.length === 0
            ? t("cohorts.list.empty")
            : t("cohorts.saved.filterEmpty")}
        </div>
      ) : (
        <div>
          <div className="bg-rv-c2 px-3.5 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t("cohorts.list.allHeading")}
          </div>
          {filtered.map((item) => {
            const active = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                className={cn(
                  "block w-full cursor-pointer border-b border-rv-divider px-3.5 py-2.5 text-left transition hover:bg-rv-c2",
                  active &&
                    "bg-[color-mix(in_srgb,var(--color-rv-accent-500)_10%,transparent)] shadow-[inset_2px_0_0_var(--color-rv-accent-500)]",
                )}
              >
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: dotColorForId(item.id) }}
                  />
                  <span className="truncate">{item.name}</span>
                </div>
                {item.description && (
                  <div className="mt-0.5 truncate font-rv-mono text-[11px] text-rv-mute-500">
                    {item.description}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
