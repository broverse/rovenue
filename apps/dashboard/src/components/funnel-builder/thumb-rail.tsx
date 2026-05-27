import { Fragment } from "react";
import { Plus, Sparkles } from "lucide-react";
import { cn } from "../../lib/cn";
import { PAGE_TYPES, type Page } from "./types";

type Props = {
  pages: Page[];
  selectedId: string;
  onSelect: (id: string) => void;
};

/**
 * Left rail in the Content tab. Vertical stack of page thumbnails
 * with insertion handles between pages and a small "endings" divider
 * before paywall / success pages.
 */
export function ThumbRail({ pages, selectedId, onSelect }: Props) {
  return (
    <aside className="flex w-[88px] flex-shrink-0 flex-col border-r border-rv-divider bg-rv-c1">
      <div className="flex items-center justify-between border-b border-rv-divider px-3 py-2.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          Pages
        </span>
        <button
          type="button"
          title="Add page"
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
        >
          <Plus size={11} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {pages.map((p, i) => {
          const meta = PAGE_TYPES[p.type];
          const Ico = meta.icon;
          const isEnding = p.type === "paywall" || p.type === "success";
          const prevWasEnding =
            i > 0 &&
            (pages[i - 1].type === "paywall" || pages[i - 1].type === "success");
          const showEndingDivider = isEnding && !prevWasEnding;
          return (
            <Fragment key={p.id}>
              {showEndingDivider && (
                <div className="my-3 flex items-center gap-2 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                  <span className="h-px flex-1 bg-rv-divider" />
                  Endings
                  <span className="h-px flex-1 bg-rv-divider" />
                </div>
              )}
              {!showEndingDivider && i > 0 && (
                <div className="my-1.5 flex justify-center opacity-0 transition-opacity hover:opacity-100">
                  <button
                    type="button"
                    className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-full border border-rv-divider bg-rv-c2 text-rv-mute-500 hover:bg-rv-c3 hover:text-foreground"
                  >
                    <Plus size={8} />
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                title={p.title}
                className={cn(
                  "group relative flex w-full cursor-pointer flex-col items-center gap-1 rounded-md border bg-rv-c2 px-2 py-2.5 text-left transition",
                  selectedId === p.id
                    ? "border-rv-accent-500/60 bg-rv-accent-500/10 shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-rv-accent-500)_18%,transparent)]"
                    : "border-rv-divider hover:border-rv-divider-strong hover:bg-rv-c3",
                  meta.tone === "paywall" && "border-rv-warning/30",
                  meta.tone === "success" && "border-rv-success/30",
                )}
              >
                <span className="absolute left-1 top-1 font-rv-mono text-[9px] text-rv-mute-500">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded text-rv-mute-600",
                    selectedId === p.id && "text-rv-accent-500",
                  )}
                >
                  <Ico size={16} />
                </div>
                {(p.validation_errors ?? 0) > 0 && (
                  <div className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-rv-danger text-[9px] font-bold text-white">
                    !
                  </div>
                )}
                {(p.branchCount ?? 0) > 0 && (p.validation_errors ?? 0) === 0 && (
                  <div
                    title={`${p.branchCount} branch rules`}
                    className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-rv-violet/80 px-1 font-rv-mono text-[9px] font-bold text-white"
                  >
                    {p.branchCount}
                  </div>
                )}
              </button>
            </Fragment>
          );
        })}
      </div>

      <button
        type="button"
        title="Personalize based on earlier answers"
        className="m-3 flex cursor-pointer items-center gap-2 rounded-md border border-rv-accent-500/30 bg-rv-accent-500/10 px-2.5 py-2 text-left text-[11px] font-medium text-rv-accent-500 transition hover:bg-rv-accent-500/15"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded bg-rv-accent-500/20">
          <Sparkles size={12} />
        </span>
        Personalize with branching
      </button>
    </aside>
  );
}
