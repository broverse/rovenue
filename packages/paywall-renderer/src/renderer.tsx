import type { JSX } from "react";
import type { PackageListNode, PackageView, PaywallNode } from "@rovenue/shared/paywall";
import type { PaywallRendererProps, RendererOffering } from "./types";
import { renderNode, packageToView, type RenderCtx } from "./nodes";
import { resolveThemeColor } from "./styles";

// =============================================================
// Root renderer. Presentational only: no network, no SDK. Walks
// the config once to find the package that {{variables}} resolve
// against (today: the first packageList's defaultSelected, or its
// first packageId — click-to-select is Task 3), builds a RenderCtx,
// and dispatches to `renderNode` for the tree.
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

function resolveSelectedPackage(
  root: PaywallNode,
  offering: RendererOffering | null,
): { selectedPackageId: string | null; selectedPackage: PackageView | null } {
  const packageList = findFirstPackageList(root);
  const selectedPackageId = packageList
    ? (packageList.defaultSelected ?? packageList.packageIds[0] ?? null)
    : null;
  if (!selectedPackageId || !offering) {
    return { selectedPackageId, selectedPackage: null };
  }
  const pkg = offering.packages.find((p) => p.packageIdentifier === selectedPackageId);
  return { selectedPackageId, selectedPackage: pkg ? packageToView(pkg) : null };
}

export function PaywallRenderer(props: PaywallRendererProps): JSX.Element {
  const { config, offering, colorScheme, onPurchase, onClose, onRestore, onUrl } = props;
  const locale = props.locale ?? config.defaultLocale;

  const { selectedPackageId, selectedPackage } = resolveSelectedPackage(config.root, offering);

  const ctx: RenderCtx = {
    config,
    offering,
    locale,
    colorScheme,
    selectedPackageId,
    selectedPackage,
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
