import { LineChart, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { SAVED_QUERY_BY_ID } from "./mock-data";

type Props = {
  openIds: ReadonlyArray<string>;
  selectedId: string;
  dirtyIds?: ReadonlyArray<string>;
  onSelect: (next: string) => void;
  onClose: (id: string) => void;
};

/**
 * Editor tab strip — open queries with a close-X, dirty dot, and an
 * always-visible "+" tab for opening a new query.
 */
export function QueryTabs({ openIds, selectedId, dirtyIds = [], onSelect, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex items-stretch gap-0 overflow-x-auto border-b border-rv-divider bg-rv-c1 px-2.5">
      {openIds.map((id) => {
        const q = SAVED_QUERY_BY_ID[id];
        const active = id === selectedId;
        const dirty = dirtyIds.includes(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            className={cn(
              "flex h-[38px] shrink-0 cursor-pointer items-center gap-2 border-r border-rv-divider px-3.5 text-[12px] transition",
              active
                ? "-mb-px border-b border-rv-bg bg-rv-bg text-foreground"
                : "text-rv-mute-600 hover:text-foreground",
            )}
          >
            <LineChart size={11} />
            <span className="max-w-[140px] truncate sm:max-w-[180px]">{q?.name ?? id}</span>
            {dirty && <span className="size-1.5 rounded-full bg-rv-warning" aria-hidden />}
            <span
              role="button"
              aria-label={t("queries.tabs.close")}
              onClick={(e) => {
                e.stopPropagation();
                onClose(id);
              }}
              className="inline-flex size-3.5 items-center justify-center rounded-sm opacity-40 hover:bg-rv-c3 hover:opacity-100"
            >
              <X size={10} />
            </span>
          </button>
        );
      })}
      <button
        type="button"
        aria-label={t("queries.tabs.new")}
        className="shrink-0 self-center px-2.5 text-rv-mute-500 hover:text-foreground"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}
