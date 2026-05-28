import { Fragment, useState } from "react";
import { component, useService } from "impair";
import { Plus, Sparkles } from "lucide-react";
import { cn } from "../../lib/cn";
import { PAGE_TYPES } from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { AddContentPopover } from "./add-content-popover";
import { blankPage } from "./blank-page";
import { resolvePage } from "./i18n";

export const ThumbRail = component(() => {
  const vm = useService(FunnelDraftViewModel);
  // Popover state is purely UI — keep it local. `insertAfter=null` means
  // append to the end of the list (rail head/footer buttons); a page id means
  // insert directly after that page (between-thumb buttons). `source` decides
  // which trigger renders the popover so its anchor matches the click point.
  const [popover, setPopover] = useState<{
    insertAfter: string | null;
    source: "header" | "footer" | "between";
  } | null>(null);
  return (
    <aside className="relative flex w-[280px] flex-shrink-0 flex-col border-r border-rv-divider bg-rv-c1">
      <div className="flex items-center justify-between border-b border-rv-divider px-3 py-2.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          Pages
        </span>
        <div className="relative">
          <button
            type="button"
            title="Add page"
            onClick={() => setPopover({ insertAfter: null, source: "header" })}
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
          >
            <Plus size={11} />
          </button>
          {popover && popover.source !== "footer" && (
            <AddContentPopover
              align="rightOfTrigger"
              onPick={(t) => {
                vm.addPage(blankPage(t, vm.defaultLocale), popover.insertAfter);
                setPopover(null);
              }}
              onClose={() => setPopover(null)}
            />
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {vm.pages.length === 0 && (
          <div className="rounded-md border border-dashed border-rv-divider bg-rv-c2 px-3 py-6 text-center">
            <div className="font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
              No pages
            </div>
            <button
              type="button"
              onClick={() => setPopover({ insertAfter: null, source: "header" })}
              className="mt-2 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border border-rv-divider bg-rv-c1 px-2.5 text-[11px] font-medium text-rv-accent-500 transition hover:bg-rv-c3"
            >
              <Plus size={11} />
              Add first page
            </button>
          </div>
        )}
        {vm.pages.map((p, i) => {
          const meta = PAGE_TYPES[p.type];
          const Ico = meta.icon;
          const isEnding = p.type === "paywall" || p.type === "success";
          const prevWasEnding =
            i > 0 &&
            (vm.pages[i - 1].type === "paywall" || vm.pages[i - 1].type === "success");
          const showEndingDivider = isEnding && !prevWasEnding;
          const issues = vm.validation.byPage.get(p.id) ?? [];
          const hasError = issues.some((iss) => iss.code !== "UNREACHABLE");
          const branchCount = (vm.rules[p.id] ?? []).length;
          const selected = vm.selectedPageId === p.id;
          const rp = resolvePage(p, vm.editLocale, vm.defaultLocale);
          const label = (rp.title ?? "").trim() || (rp.headline ?? "").trim() || meta.label;
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
                    onClick={() =>
                      setPopover({ insertAfter: vm.pages[i - 1].id, source: "between" })
                    }
                    className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-full border border-rv-divider bg-rv-c2 text-rv-mute-500 hover:bg-rv-c3 hover:text-foreground"
                  >
                    <Plus size={8} />
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => vm.selectPage(p.id)}
                title={label}
                className={cn(
                  "group relative flex w-full cursor-pointer items-center gap-2.5 rounded-md border bg-rv-c2 px-2.5 py-2 text-left transition",
                  selected
                    ? "border-rv-accent-500/60 bg-rv-accent-500/10 shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-rv-accent-500)_18%,transparent)]"
                    : "border-rv-divider hover:border-rv-divider-strong hover:bg-rv-c3",
                  meta.tone === "paywall" && "border-rv-warning/30",
                  meta.tone === "success" && "border-rv-success/30",
                )}
              >
                <div
                  className={cn(
                    "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded text-rv-mute-600",
                    selected && "text-rv-accent-500",
                  )}
                >
                  <Ico size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 font-rv-mono text-[10px] text-rv-mute-500">
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    <span className="truncate">{meta.label}</span>
                  </div>
                  <div className="truncate text-[12px] font-medium text-foreground">
                    {label}
                  </div>
                </div>
                {hasError && (
                  <div
                    title="Has validation issues"
                    className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-rv-danger text-[9px] font-bold text-white"
                  >
                    !
                  </div>
                )}
                {!hasError && branchCount > 0 && (
                  <div
                    title={`${branchCount} branch rule${branchCount === 1 ? "" : "s"}`}
                    className="flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full bg-rv-violet/80 px-1 font-rv-mono text-[9px] font-bold text-white"
                  >
                    {branchCount}
                  </div>
                )}
              </button>
            </Fragment>
          );
        })}
      </div>

      {vm.pages.length > 0 && (
        <div className="relative border-t border-rv-divider px-3 py-2.5">
          <button
            type="button"
            onClick={() => setPopover({ insertAfter: null, source: "footer" })}
            className="flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-rv-divider bg-rv-c2 text-[11px] font-medium text-rv-accent-500 transition hover:border-rv-accent-500/50 hover:bg-rv-c3"
          >
            <Plus size={12} />
            Add page
          </button>
          {popover && popover.source === "footer" && (
            <AddContentPopover
              align="rightOfTrigger"
              verticalAlign="bottom"
              onPick={(t) => {
                vm.addPage(blankPage(t, vm.defaultLocale), popover.insertAfter);
                setPopover(null);
              }}
              onClose={() => setPopover(null)}
            />
          )}
        </div>
      )}

      <button
        type="button"
        title="Personalize based on earlier answers"
        className="m-3 flex cursor-pointer items-center gap-2 rounded-md border border-rv-accent-500/30 bg-rv-accent-500/10 px-2.5 py-2 text-left text-[11px] font-medium text-rv-accent-500 transition hover:bg-rv-accent-500/15"
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-rv-accent-500/20">
          <Sparkles size={12} />
        </span>
        <span className="truncate">Personalize with branching</span>
      </button>
    </aside>
  );
});
