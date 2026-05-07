import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search } from "lucide-react";
import { cn } from "../../lib/cn";
import { dotColor } from "./format";
import type { CohortGroupKey, SavedCohort } from "./types";

type Props = {
  cohorts: ReadonlyArray<SavedCohort>;
  selectedId: string;
  onSelect: (id: string) => void;
};

const GROUP_ORDER: ReadonlyArray<CohortGroupKey> = [
  "Behavior",
  "Lifecycle",
  "Risk",
  "Acquisition",
];

export function SavedCohortsRail({ cohorts, selectedId, onSelect }: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");

  const filtered = useMemo<ReadonlyArray<SavedCohort>>(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return cohorts;
    return cohorts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q),
    );
  }, [cohorts, filter]);

  const groups = useMemo(() => {
    const map = new Map<CohortGroupKey, SavedCohort[]>();
    for (const item of filtered) {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [filtered]);

  return (
    <aside className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-center justify-between border-b border-rv-divider px-3.5 py-3">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("cohorts.saved.heading")}
        </h4>
        <button
          type="button"
          aria-label={t("cohorts.saved.newAria")}
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

      {groups.map(([group, items]) => (
        <div key={group}>
          <div className="bg-rv-c2 px-3.5 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t(`cohorts.saved.groups.${group}`)}
          </div>
          {items.map((item) => {
            const active = item.id === selectedId;
            const negative = item.growth.startsWith("−");
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
                    style={{ background: dotColor(item.dot) }}
                  />
                  <span className="truncate">{item.name}</span>
                </div>
                <div className="mt-0.5 font-rv-mono text-[11px] tabular-nums text-rv-mute-500">
                  {item.size.toLocaleString()} ·{" "}
                  <span className={negative ? "text-rv-danger" : "text-rv-success"}>
                    {item.growth}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
