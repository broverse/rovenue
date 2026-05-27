import { Search } from "lucide-react";
import { PAGE_GROUPS, PAGE_TYPE_DESC, PAGE_TYPES, type PageType } from "./types";

// `align` controls where the 360px popover anchors relative to its trigger:
//   - "left"          → flush with trigger's left edge (default; for wide containers)
//   - "right"         → flush with trigger's right edge
//   - "rightOfTrigger"→ starts where the trigger ends, opens into the next column.
//                       Use this inside narrow surfaces (the ThumbRail) where
//                       neither left- nor right-anchored 360px would fit.
export function AddContentPopover({
  onPick,
  onClose,
  align = "left",
  verticalAlign = "top",
}: {
  onPick: (type: PageType) => void;
  onClose: () => void;
  align?: "left" | "right" | "rightOfTrigger";
  // Anchor the popover's top or bottom edge to the trigger. Use "bottom" when
  // the trigger sits near the viewport's lower edge (e.g. ThumbRail footer)
  // so the popover opens upward instead of overflowing past the screen.
  verticalAlign?: "top" | "bottom";
}) {
  const alignClass =
    align === "right"
      ? "right-0"
      : align === "rightOfTrigger"
        ? "left-full ml-2"
        : "left-0";
  const verticalClass = verticalAlign === "bottom" ? "bottom-0" : "top-0";
  return (
    <>
      <div className="fixed inset-0 z-[49]" onClick={onClose} />
      <div
        onClick={(e) => e.stopPropagation()}
        className={`absolute z-50 flex max-h-[min(80vh,640px)] w-[360px] flex-col rounded-lg border border-rv-divider-strong bg-rv-c1 p-3 shadow-[0_18px_44px_rgba(0,0,0,0.5)] ${verticalClass} ${alignClass}`}
      >
        <div className="mb-2 flex flex-shrink-0 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2">
          <Search size={13} className="text-rv-mute-500" />
          <input
            autoFocus
            placeholder="Search content type… (e.g. paywall, slider)"
            className="h-7 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-rv-mute-500"
          />
        </div>
        <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
          {PAGE_GROUPS.map((g) => (
            <div key={g.label} className="mt-2 first:mt-0">
              <div className="mb-1.5 px-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
                {g.label}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {g.types.map((t) => {
                  const m = PAGE_TYPES[t];
                  const I = m.icon;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => onPick(t)}
                      className="flex cursor-pointer items-start gap-2 rounded border border-rv-divider bg-rv-c2 p-2 text-left transition hover:border-rv-accent-500 hover:bg-rv-c3"
                    >
                      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded bg-rv-c3 text-rv-mute-600">
                        <I size={14} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium text-foreground">{m.label}</div>
                        <div className="text-[10px] text-rv-mute-500">{PAGE_TYPE_DESC[t]}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
