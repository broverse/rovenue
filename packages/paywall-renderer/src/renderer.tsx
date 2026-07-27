import { useEffect, useRef, useState, type JSX } from "react";
import type { PackageListNode, PaywallNode, StickyFooterNode } from "@rovenue/shared/paywall";
import type { PaywallRendererProps, RendererOffering } from "./types";
import { effectivePackageIds, renderNode, resolvePackageView, type RenderCtx } from "./nodes";
import { resolveThemeColor } from "./styles";

/**
 * Pre-measurement initial value for the scrolled content's bottom clearance,
 * used only until the first `ResizeObserver` callback reports the footer's
 * real height — a static guess is otherwise wrong whenever the footer is
 * taller than it (a CTA plus fine print routinely is), leaving the last
 * scrolled item unreachable, the same class of bug as no scrolling at all.
 */
const STICKY_FOOTER_CONTENT_CLEARANCE_PX = 96;

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
 * "the pinned footer", per the LAST direct child only: a `stickyFooter`
 * anywhere else (not last, not a direct child at all) is left in place and
 * reaches the ordinary dispatcher, which renders it in-flow like a stack —
 * see `renderStickyFooter` in `nodes.tsx`. The validator's
 * `STICKY_FOOTER_NOT_AT_ROOT` warning is what tells the author about that
 * case; this function does not warn, only partitions.
 */
function partitionRootChildren(children: PaywallNode[]): {
  scrolledChildren: PaywallNode[];
  stickyFooter: StickyFooterNode | null;
} {
  const last = children[children.length - 1];
  if (last?.type === "stickyFooter") {
    return { scrolledChildren: children.slice(0, -1), stickyFooter: last };
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
      if (entry) setFooterClearance(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [stickyFooter?.id]);

  return (
    <div
      data-rov-paywall-root=""
      style={{
        backgroundColor: resolveThemeColor(config.background, colorScheme),
        boxSizing: "border-box",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div data-rov-paywall-scroll="" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {/* minHeight 100% is what keeps a short paywall filling the screen;
            without it a flexible spacer collapses and the CTA rides up. */}
        <div
          data-rov-paywall-content=""
          style={{
            minHeight: "100%",
            display: "flex",
            flexDirection: "column",
            // Reserve clearance for the pinned footer below, or the last
            // scrolled item ends up underneath it and unreachable — the
            // same class of bug as no scrolling at all, just subtler.
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
            flexShrink: 0,
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          {footerElement}
        </div>
      ) : null}
    </div>
  );
}
