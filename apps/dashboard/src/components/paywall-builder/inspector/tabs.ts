import { isPublishBlockingIssue, type BuilderIssue, type PaywallNode } from "@rovenue/shared/paywall";

// =============================================================
// The inspector's tab table. Each tab declares everything about
// itself — which node types it applies to, and which validator issue
// codes have their offending field on it — so there is no second
// place to keep in step when a tab is added.
// =============================================================

export interface InspectorTab {
  id: "layout" | "style" | "content" | "binding";
  /** English fallback; the label is t(`paywalls.builder.inspector.tab.${id}`, fallbackLabel). */
  fallbackLabel: string;
  appliesTo: ReadonlySet<PaywallNode["type"]>;
  /**
   * Issue codes whose offending field lives on this tab. A code absent
   * from every tab gets no dot on purpose: DUPLICATE_NODE_ID is not a
   * field, MISSING_PURCHASE_BUTTON is a property of the tree rather than
   * of a node, LOCALE_KEY_GAP is per-locale, and the OVERRIDE_* codes
   * belong to the overrides section, which sits outside the strip. The
   * validation drawer remains the complete list; this is a pointer.
   */
  issueCodes: ReadonlySet<BuilderIssue["code"]>;
}

/** Declaration order IS display order. */
export const INSPECTOR_TABS: readonly InspectorTab[] = [
  {
    id: "layout",
    fallbackLabel: "Layout",
    appliesTo: new Set(["stack", "image", "packageList", "spacer"]),
    issueCodes: new Set(["CELL_TEMPLATE_BAD_NODE"]),
  },
  {
    id: "style",
    fallbackLabel: "Style",
    appliesTo: new Set(["stack", "text", "image", "button"]),
    issueCodes: new Set<BuilderIssue["code"]>(),
  },
  {
    id: "content",
    fallbackLabel: "Content",
    appliesTo: new Set(["text", "image", "button", "purchaseButton"]),
    issueCodes: new Set(["UNKNOWN_LOC_KEY", "EMPTY_LOC_VALUE"]),
  },
  {
    id: "binding",
    fallbackLabel: "Binding",
    appliesTo: new Set(["button", "packageList"]),
    issueCodes: new Set(["FOREIGN_PACKAGE_ID"]),
  },
];

export type InspectorTabId = (typeof INSPECTOR_TABS)[number]["id"];

/** The tabs a node type has anything to configure on, in table order. */
export function tabsForNode(type: PaywallNode["type"]): readonly InspectorTab[] {
  return INSPECTOR_TABS.filter((tab) => tab.appliesTo.has(type));
}

/**
 * Severity per tab for one node: "error" when any of that tab's issues
 * blocks publishing, "warning" otherwise. Severity is read from the shared
 * model rather than restated here.
 *
 * NOTE: every code currently mapped to a tab is publish-blocking, so the
 * "warning" result is unreachable as things stand. It is kept because the
 * severity question belongs here rather than at the call site, and because
 * mapping a warning-tier code later should not need this function changed
 * — but do not read the branch as evidence that warning dots exist.
 */
export function tabIssues(
  issues: BuilderIssue[],
  nodeId: string,
): Map<InspectorTabId, "error" | "warning"> {
  const out = new Map<InspectorTabId, "error" | "warning">();
  for (const issue of issues) {
    if (issue.nodeId !== nodeId) continue;
    for (const tab of INSPECTOR_TABS) {
      if (!tab.issueCodes.has(issue.code)) continue;
      const severity = isPublishBlockingIssue(issue) ? "error" : "warning";
      if (severity === "error" || !out.has(tab.id)) out.set(tab.id, severity);
    }
  }
  return out;
}

/**
 * Keep the author's current tab across a selection change when it still
 * applies; otherwise fall back to the new node's FIRST applicable tab
 * rather than a fixed default, so the fallback is always meaningful.
 */
export function resolveActiveTab(
  current: InspectorTabId | null,
  type: PaywallNode["type"],
): InspectorTabId | null {
  const applicable = tabsForNode(type);
  if (current && applicable.some((tab) => tab.id === current)) return current;
  return applicable[0]?.id ?? null;
}
