import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { PaywallNode } from "@rovenue/shared/paywall";
import { NODE_ICON, NODE_TYPE_LABEL, NODE_TYPES } from "./node-meta";

// Panel geometry — named per the project's no-magic-values rule, and
// referenced from both the inline style below and the Tailwind classes.
/** Fixed panel width — the type list never needs to be wider than this. */
const POPOVER_WIDTH_PX = 220;
/** The type list has grown past a single screenful (Wave D2 added
 *  video/lottie/carousel/stickyFooter/countdown/etc, past the original 7
 *  entries) — cap the panel's height and let the list scroll internally
 *  rather than spilling off-screen. */
const POPOVER_MAX_HEIGHT_VH = 60;
/** Gap between the anchor button and the panel. */
const POPOVER_GAP_PX = 4;
/** Minimum breathing room from any viewport edge. */
const POPOVER_VIEWPORT_MARGIN_PX = 8;

/**
 * Fixed-position coordinates (+ an effective max-height) for the panel,
 * derived from the anchor button's rect (captured once, at open time, by
 * the caller) and clamped so the panel never overflows the viewport:
 *  - horizontally: clamps `left` so the panel's right edge never crosses
 *    the viewport's right edge.
 *  - vertically: opens below the anchor by default; flips to open
 *    upward when there isn't enough room below but there is above — a
 *    row's own "+" near the bottom of a long, scrolled layer list is the
 *    case this exists for.
 *  - height: `POPOVER_MAX_HEIGHT_VH` is a PREFERENCE, not a guarantee — on
 *    a short viewport (or an anchor near the top/bottom edge) that much
 *    space may not actually be available in whichever direction was
 *    chosen. Clamping `maxHeight` to the real available space keeps the
 *    panel fully on-screen and internally scrollable rather than
 *    rendering past the viewport edge with no way to reach the rest.
 */
function computePopoverStyle(anchorRect: DOMRect): CSSProperties {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const maxLeft = viewportWidth - POPOVER_VIEWPORT_MARGIN_PX - POPOVER_WIDTH_PX;
  const left = Math.max(POPOVER_VIEWPORT_MARGIN_PX, Math.min(anchorRect.left, maxLeft));

  // Space on each side, net of the anchor gap and a viewport-edge margin —
  // i.e. the room the panel could actually occupy in that direction.
  const spaceBelow = viewportHeight - anchorRect.bottom - POPOVER_GAP_PX - POPOVER_VIEWPORT_MARGIN_PX;
  const spaceAbove = anchorRect.top - POPOVER_GAP_PX - POPOVER_VIEWPORT_MARGIN_PX;
  const preferredHeight = viewportHeight * (POPOVER_MAX_HEIGHT_VH / 100);
  const openUpward = spaceBelow < preferredHeight && spaceBelow < spaceAbove;

  const availableSpace = openUpward ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(0, Math.min(preferredHeight, availableSpace));

  if (openUpward) {
    return { left, bottom: viewportHeight - anchorRect.top + POPOVER_GAP_PX, maxHeight };
  }
  return { left, top: anchorRect.bottom + POPOVER_GAP_PX, maxHeight };
}

/**
 * Node-type palette. Rendered via a PORTAL to `document.body` — the two
 * anchor points (a LayerRow's own "+" and the Layers panel's "New Element"
 * button) both live inside `layer-tree.tsx`'s `<aside>`, which needs
 * `overflow-y-auto` for its own row list. Per the CSS overflow model, that
 * clips ANY descendant regardless of its own `position` — `fixed` does not
 * escape a clipping ancestor it is still a descendant of — so the only
 * reliable fix is to not be a descendant of it at all. Positioning is
 * `fixed`, computed from `anchorRect` (the anchor's `getBoundingClientRect()`
 * at open time, captured by the caller since layout can't be read from
 * inside a portal-rendered child before its own first paint).
 */
export function AddNodePopover({
  anchorRect,
  onPick,
  onClose,
}: {
  anchorRect: DOMRect;
  onPick: (type: PaywallNode["type"]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return createPortal(
    <>
      <div className="fixed inset-0 z-[49]" onClick={onClose} />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          ...computePopoverStyle(anchorRect),
          width: POPOVER_WIDTH_PX,
        }}
        className="fixed z-50 flex flex-col rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]"
      >
        <div className="mb-1 flex-shrink-0 px-1.5 py-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
          {t("paywalls.builder.addNode.title", "Add node")}
        </div>
        <div className="min-h-0 overflow-y-auto">
          {NODE_TYPES.map((type) => {
            const Icon = NODE_ICON[type];
            return (
              <button
                key={type}
                type="button"
                onClick={() => onPick(type)}
                className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground transition hover:bg-rv-c2"
              >
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-rv-c3 text-rv-mute-600">
                  <Icon size={13} />
                </span>
                {t(`paywalls.builder.nodeTypes.${type}`, NODE_TYPE_LABEL[type])}
              </button>
            );
          })}
        </div>
      </div>
    </>,
    document.body,
  );
}
