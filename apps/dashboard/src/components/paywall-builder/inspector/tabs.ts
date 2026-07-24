import { isPublishBlockingIssue, type BuilderIssue, type PaywallNode } from "@rovenue/shared/paywall";

// =============================================================
// The inspector's tab table. Each tab declares everything about
// itself — which node types it applies to, and which validator issue
// codes have their offending field on it — so there is no second
// place to keep in step when a tab is added.
// =============================================================

/**
 * Structural constraint for a table entry. `id` is left as `string` on
 * purpose: `InspectorTabId` is derived from the TABLE, so a hand-written
 * union here would make that derivation circular and adding a tab would
 * need a type edit as well as a table edit.
 */
interface InspectorTabShape {
  id: string;
  /** English fallback; the label is t(`paywalls.builder.inspector.tab.${id}`, fallbackLabel). */
  fallbackLabel: string;
  appliesTo: ReadonlySet<PaywallNode["type"]>;
  /**
   * Issue codes whose offending field lives on this tab. A code absent
   * from every tab gets no dot on purpose: DUPLICATE_NODE_ID is not a
   * field, MISSING_PURCHASE_BUTTON is a property of the tree rather than
   * of a node, LOCALE_KEY_GAP is per-locale, and the OVERRIDE_* codes
   * belong to the overrides section, which sits outside the strip.
   *
   * CELL_TEMPLATE_BAD_NODE is in the same family and deliberately absent.
   * It names the OFFENDING node — a packageList or purchaseButton sitting
   * inside a cellTemplate — not the packageList that owns the template, so
   * there is no field on the named node to point at; the fault is where the
   * node sits. Mapping it to Layout also dropped the dot outright, because
   * a purchaseButton has no Layout tab for it to render on. The


   * validation drawer remains the complete list; this is a pointer.
   */
  issueCodes: ReadonlySet<BuilderIssue["code"]>;
}

/** Declaration order IS display order.
 *
 * `as const satisfies` rather than a `readonly InspectorTab[]` annotation:
 * the annotation would widen every `id` to the interface's type and make
 * `InspectorTabId` derive from that instead of from these entries. `satisfies`
 * still type-checks each entry against `InspectorTab`. Same shape as PRESETS. */
export const INSPECTOR_TABS = [
  {
    id: "layout",
    fallbackLabel: "Layout",
    appliesTo: new Set<PaywallNode["type"]>(["stack", "image", "packageList", "spacer"]),
    issueCodes: new Set<BuilderIssue["code"]>(),
  },
  {
    id: "style",
    fallbackLabel: "Style",
    appliesTo: new Set<PaywallNode["type"]>(["stack", "text", "image", "button"]),
    issueCodes: new Set<BuilderIssue["code"]>(),
  },
  {
    id: "content",
    fallbackLabel: "Content",
    appliesTo: new Set<PaywallNode["type"]>(["text", "image", "button", "purchaseButton"]),
    issueCodes: new Set<BuilderIssue["code"]>(["UNKNOWN_LOC_KEY", "EMPTY_LOC_VALUE"]),
  },
  {
    id: "binding",
    fallbackLabel: "Binding",
    appliesTo: new Set<PaywallNode["type"]>(["button", "packageList"]),
    issueCodes: new Set<BuilderIssue["code"]>(["FOREIGN_PACKAGE_ID"]),
  },
  {
    id: "visibility",
    fallbackLabel: "Visibility",
    appliesTo: new Set<PaywallNode["type"]>([
      "stack",
      "text",
      "image",
      "button",
      "packageList",
      "purchaseButton",
      "spacer",
    ]),
    issueCodes: new Set<BuilderIssue["code"]>(["VISIBILITY_NEVER_MATCHES", "VISIBILITY_BOUND_UNPARSEABLE"]),
  },
] as const satisfies readonly InspectorTabShape[];

/** One table entry, with its literal `id` preserved. */
export type InspectorTab = (typeof INSPECTOR_TABS)[number];
export type InspectorTabId = InspectorTab["id"];

/** The tabs a node type has anything to configure on, in table order. */
export function tabsForNode(type: PaywallNode["type"]): readonly InspectorTab[] {
  return INSPECTOR_TABS.filter((tab) => tab.appliesTo.has(type));
}

/**
 * Severity per tab for one node: "error" when any of that tab's issues
 * blocks publishing, "warning" otherwise. Severity is read from the shared
 * model rather than restated here.
 *
 * Both severities are reachable: VISIBILITY_NEVER_MATCHES is warning tier,
 * every other mapped code is publish-blocking. (This note used to say the
 * warning branch was unreachable — it was, until the Visibility tab mapped
 * a warning-tier code to it.)
 */
export interface TabIssueSummary {
  severity: "error" | "warning";
  count: number;
}

export function tabIssues(
  issues: BuilderIssue[],
  nodeId: string,
): Map<InspectorTabId, TabIssueSummary> {
  const out = new Map<InspectorTabId, TabIssueSummary>();
  for (const issue of issues) {
    if (issue.nodeId !== nodeId) continue;
    for (const tab of INSPECTOR_TABS) {
      if (!tab.issueCodes.has(issue.code)) continue;
      const severity = isPublishBlockingIssue(issue) ? "error" : "warning";
      const prev = out.get(tab.id);
      out.set(tab.id, {
        // An error is never demoted by a later warning, whatever the order.
        severity: prev?.severity === "error" || severity === "error" ? "error" : "warning",
        count: (prev?.count ?? 0) + 1,
      });
    }
  }
  return out;
}

/**
 * Which tab to open on when nothing is carried over. Table order is the
 * MOCK's order (Layout first), but the copy is what authors edit most: a
 * freshly added text or button node renders blank until its string is
 * written, and opening on Style would put Role/Align/Color in front of the
 * author while the text input sat one click away. Display order and
 * open-first order are two different questions.
 */
const PREFERRED_INITIAL_TAB = "content";

/**
 * Keep the author's current tab across a selection change when it still
 * applies; otherwise open the preferred tab if the new node has it, and
 * fall back to that node's FIRST applicable tab if it does not — never a
 * fixed default that the node might not offer.
 */
export function resolveActiveTab(
  current: InspectorTabId | null,
  type: PaywallNode["type"],
): InspectorTabId | null {
  const applicable = tabsForNode(type);
  if (current && applicable.some((tab) => tab.id === current)) return current;
  const preferred = applicable.find((tab) => tab.id === PREFERRED_INITIAL_TAB);
  return preferred?.id ?? applicable[0]?.id ?? null;
}
