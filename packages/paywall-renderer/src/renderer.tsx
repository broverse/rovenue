import { useEffect, useRef, useState, type JSX } from "react";
import {
  STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT,
  type PackageListNode,
  type PaywallNode,
  type StickyFooterNode,
} from "@rovenue/shared/paywall";
import type { PaywallRendererProps, RendererOffering } from "./types";
import { effectivePackageIds, renderNode, resolvePackageView, type RenderCtx } from "./nodes";
import { resolveThemeColor } from "./styles";

/**
 * Pre-measurement initial value for the scrolled content's bottom clearance,
 * used only until the first `ResizeObserver` callback reports the footer's
 * real height — a static guess is otherwise wrong whenever the footer is
 * taller than it (a CTA plus fine print routinely is), leaving the last
 * scrolled item unreachable, the same class of bug as no scrolling at all.
 *
 * Imported rather than retyped: iOS and Android hand-mirror the same number
 * as `pt`/`dp`, and `render-fixtures.json`'s `defaults` is where the three
 * copies are compared.
 */
const STICKY_FOOTER_CONTENT_CLEARANCE_PX = STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT;

/**
 * The scrolled content box lays its single child — the root stack — out as
 * ONE grid row of `1fr`, which is what actually delivers the `minHeight:
 * 100%` below to that stack.
 *
 * Grid, not flex, and that is the whole point. A flex column would size its
 * item by flex-basis (`auto` → the stack's own content height) plus
 * `flex-grow`, and `flex-grow` is not ours to set here: the root stack is
 * produced by the generic `renderNode` dispatcher, which knows nothing about
 * being at the root (`align-items: stretch` does not help — in a column
 * container it governs the horizontal axis). So the extra viewport height
 * would sit unused BELOW the stack, and spec §2.1's "short content still
 * fills and distributes" would not land on the web at all. A `1fr` grid row
 * stretches its item on the BLOCK axis by default, so the stack is handed
 * `max(its content, the viewport minimum)` with no per-node cooperation —
 * the same thing SwiftUI's `.frame(minHeight:)` and Android's
 * `fillViewport` hand their root stacks.
 *
 * `1fr` is `minmax(auto, 1fr)`, so the row's minimum is still the content:
 * a LONG paywall grows past the minimum and scrolls exactly as before.
 */
const CONTENT_FILL_GRID_TEMPLATE_ROWS = "1fr";

/**
 * The footer OVERLAYS the scroll area (it is absolutely positioned over the
 * scroller, not a flex sibling beside it), so it must paint above the
 * scrolled content. One layer is enough: nothing else in this renderer
 * establishes a stacking order at the root.
 */
const STICKY_FOOTER_Z_INDEX = 1;

// =============================================================
// Root renderer. Presentational plus the one piece of local state
// this package owns: which package is selected. Walks the config
// once to find the initial selection (the first packageList's
// defaultSelected, else its first packageId, else the offering's
// first package — see `initialSelectedPackageId`), lifts it into
// useState so packageList cells can change it via click, builds a
// RenderCtx, and dispatches to `renderNode` for the tree.
// =============================================================

/** Depth-first search over the PRIMARY tree (not fallback subtrees) for the first packageList node. */
function findFirstPackageList(node: PaywallNode): PackageListNode | null {
  if (node.type === "packageList") return node;
  if (node.type === "stack") {
    for (const child of node.children) {
      const found = findFirstPackageList(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Initial selection, in order: the first packageList's defaultSelected,
 * else the first effective package ID (rendering all offering packages when packageIds is empty),
 * else null.
 */
function initialSelectedPackageId(root: PaywallNode, offering: RendererOffering | null): string | null {
  const packageList = findFirstPackageList(root);
  if (packageList?.defaultSelected) return packageList.defaultSelected;
  const effectiveIds = effectivePackageIds(packageList?.packageIds ?? [], offering);
  return effectiveIds[0] ?? null;
}

/**
 * Split the root's direct children into "everything the scroller owns" and
 * "the pinned footer".
 *
 * The rule (shared across all three renderers, stated authoritatively in
 * `validate.ts`'s sticky-footer block): a `stickyFooter` is pinned when it
 * is a DIRECT child of the root, WHEREVER it sits among its siblings; among
 * several direct-child footers the LAST one wins and the earlier ones stay
 * in the scrolled content, reaching the ordinary dispatcher which renders
 * them in-flow like a stack (see `renderStickyFooter` in `nodes.tsx`).
 * Position among siblings deliberately does not matter for a single footer:
 * a pinned bar's position is the bottom of the screen either way, so an
 * author who dropped it above a text node still gets what they meant — the
 * previous "last child only" reading silently un-pinned that shape and the
 * validator, which only warns about non-direct children, said nothing.
 *
 * A footer that is not a direct root child at all is left where it is and
 * renders inline; the validator's `STICKY_FOOTER_NOT_AT_ROOT` warning is
 * what tells the author about that. This function does not warn, only
 * partitions.
 */
function partitionRootChildren(children: PaywallNode[]): {
  scrolledChildren: PaywallNode[];
  stickyFooter: StickyFooterNode | null;
} {
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const child = children[i];
    if (child?.type === "stickyFooter") {
      return { scrolledChildren: [...children.slice(0, i), ...children.slice(i + 1)], stickyFooter: child };
    }
  }
  return { scrolledChildren: children, stickyFooter: null };
}

export function PaywallRenderer(props: PaywallRendererProps): JSX.Element {
  const { config, offering, colorScheme, priceView, eligibility, platform, appVersion, onPurchase, onClose, onRestore, onUrl } = props;
  const locale = props.locale ?? config.defaultLocale;
  const now = props.now ?? new Date();

  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(() =>
    initialSelectedPackageId(config.root, offering),
  );

  const selectedPackage = resolvePackageView(offering, priceView, selectedPackageId);

  const ctx: RenderCtx = {
    config,
    offering,
    locale,
    colorScheme,
    now,
    firstShownAt: props.firstShownAt,
    priceView,
    eligibility,
    selectedPackageId,
    selectedPackage,
    platform,
    appVersion,
    insideCellTemplate: false,
    cellPackageId: null,
    onSelectPackage: setSelectedPackageId,
    onPurchase,
    onClose,
    onRestore,
    onUrl,
  };

  const { scrolledChildren, stickyFooter } = partitionRootChildren(config.root.children);
  // Same root container (spacing/align/background/etc.), fewer children —
  // the footer itself is rendered and pinned separately below.
  const scrolledRoot: PaywallNode = { ...config.root, children: scrolledChildren };
  const footerElement = stickyFooter !== null ? renderNode(stickyFooter, ctx) : null;

  const footerRef = useRef<HTMLDivElement>(null);
  const [footerClearance, setFooterClearance] = useState<number>(STICKY_FOOTER_CONTENT_CLEARANCE_PX);

  // Measure the footer's real height rather than guessing it: a static
  // constant is wrong whenever the footer is taller than it, which a CTA
  // plus fine print routinely is. Re-attaches only when the footer's
  // presence/identity actually changes (not on every render, since
  // `footerElement` is a fresh element each render). Environments without
  // `ResizeObserver` (none in this codebase today, but defensive) keep the
  // pre-measurement constant as their permanent value.
  useEffect(() => {
    const el = footerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      // Border box, not content box: the footer carries its own
      // safe-area bottom padding, and the content has to clear THAT too —
      // `contentRect` excludes it, so on a device with a home indicator the
      // content would stop short by exactly the inset. `borderBoxSize` is
      // the modern field; `contentRect` is the fallback for anything that
      // does not report it (and for the test double).
      if (entry) setFooterClearance(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [stickyFooter?.id]);

  return (
    // The footer OVERLAYS the scroll area rather than standing beside it —
    // the layout model the spec is written for ("the scrolled content gets
    // bottom padding equal to the footer's height so the last item is never
    // hidden beneath it", and the opaque-background default that exists
    // precisely because content scrolls *under* a pinned bar). A flex
    // sibling would shorten the scroller by the footer's height AND then
    // pad the content by it again — the same clearance counted twice. So
    // the root is only a positioning context here; the scroller fills it.
    <div
      data-rov-paywall-root=""
      style={{
        backgroundColor: resolveThemeColor(config.background, colorScheme),
        boxSizing: "border-box",
        position: "relative",
        height: "100%",
      }}
    >
      <div data-rov-paywall-scroll="" style={{ height: "100%", overflowY: "auto" }}>
        {/* minHeight 100% is what keeps a short paywall filling the screen;
            without it a flexible spacer collapses and the CTA rides up.
            The single `1fr` grid row is what passes that minimum ON to the
            root stack — see CONTENT_FILL_GRID_TEMPLATE_ROWS. Both halves are
            needed: the minimum with nothing to hand it to is the same
            no-op as no minimum at all. */}
        <div
          data-rov-paywall-content=""
          style={{
            // border-box, so the footer clearance below is carved OUT of the
            // 100% minimum instead of being added to it. content-box here
            // would make every short footered paywall exactly one footer's
            // height of blank space too tall, i.e. scrollable for nothing.
            boxSizing: "border-box",
            minHeight: "100%",
            display: "grid",
            gridTemplateRows: CONTENT_FILL_GRID_TEMPLATE_ROWS,
            // Reserve clearance for the footer overlaying the bottom of the
            // scroll area, or the last scrolled item ends up underneath it
            // and unreachable — the same class of bug as no scrolling at
            // all, just subtler.
            paddingBottom: footerElement !== null ? `${footerClearance}px` : undefined,
          }}
        >
          {renderNode(scrolledRoot, ctx)}
        </div>
      </div>
      {footerElement !== null ? (
        <div
          ref={footerRef}
          data-rov-sticky-footer=""
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: STICKY_FOOTER_Z_INDEX,
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          {footerElement}
        </div>
      ) : null}
    </div>
  );
}
