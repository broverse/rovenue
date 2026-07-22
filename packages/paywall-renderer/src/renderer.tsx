import { useState, type JSX } from "react";
import type { PackageListNode, PaywallNode } from "@rovenue/shared/paywall";
import type { PaywallRendererProps, RendererOffering } from "./types";
import { renderNode, resolvePackageView, type RenderCtx } from "./nodes";
import { resolveThemeColor } from "./styles";

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
 * else its first packageId, else (no packageList in the tree at all) the
 * offering's first package, else null.
 */
function initialSelectedPackageId(root: PaywallNode, offering: RendererOffering | null): string | null {
  const packageList = findFirstPackageList(root);
  return (
    packageList?.defaultSelected ??
    packageList?.packageIds[0] ??
    offering?.packages[0]?.packageIdentifier ??
    null
  );
}

export function PaywallRenderer(props: PaywallRendererProps): JSX.Element {
  const { config, offering, colorScheme, priceView, onPurchase, onClose, onRestore, onUrl } = props;
  const locale = props.locale ?? config.defaultLocale;

  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(() =>
    initialSelectedPackageId(config.root, offering),
  );

  const selectedPackage = resolvePackageView(offering, priceView, selectedPackageId);

  const ctx: RenderCtx = {
    config,
    offering,
    locale,
    colorScheme,
    priceView,
    selectedPackageId,
    selectedPackage,
    onSelectPackage: setSelectedPackageId,
    onPurchase,
    onClose,
    onRestore,
    onUrl,
  };

  return (
    <div
      data-rov-paywall-root=""
      style={{
        backgroundColor: resolveThemeColor(config.background, colorScheme),
        boxSizing: "border-box",
      }}
    >
      {renderNode(config.root, ctx)}
    </div>
  );
}
