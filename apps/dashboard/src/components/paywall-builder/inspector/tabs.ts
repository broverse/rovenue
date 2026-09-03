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
    appliesTo: new Set<PaywallNode["type"]>([
      "stack",
      "text",
      "image",
      "button",
      "purchaseButton",
      "divider",
      "icon",
      "featureList",
      "timeline",
      "socialProof",
      "stickyFooter",
      "countdown",
      "carousel",
      "footerLinks",
    ]),
    issueCodes: new Set<BuilderIssue["code"]>(),
  },
  {
    id: "content",
    fallbackLabel: "Content",
    appliesTo: new Set<PaywallNode["type"]>([
      "text",
      "image",
      "button",
      "purchaseButton",
      "divider",
      "icon",
      "featureList",
      "timeline",
      "socialProof",
      "countdown",
      "carousel",
      "video",
      "lottie",
      "footerLinks",
    ]),
    // The three wave-D2 media codes are here because their offending field
    // really is on this tab: Autoplay/Muted, Poster URL and Speed are all
    // edited in VideoContent/LottieContent. Without the mapping the author
    // gets no dot on the tab they would have to open to fix the issue.
    // VIDEO_IN_CAROUSEL_NO_FALLBACK is deliberately absent, in the
    // CELL_TEMPLATE_BAD_NODE family: its remedy is a `fallback` subtree,
    // which no tab in this strip edits.
    //
    // EMPTY_MEDIA_URL is here for the same reason as the wave-D2 codes:
    // image/video/lottie `url` and video's `posterUrl` are all
    // ThemeUrlFields inside ImageContent/VideoContent/LottieContent, on
    // this tab, for every node type that can raise it.
    //
    // EMPTY_ACTION_URL is deliberately NOT here, even though the same code
    // is also raised for footerLinks links whose action IS edited on this
    // tab (FooterLinksContent's ActionField). `tabIssues` below matches a
    // code to a tab by nodeId + code membership only — it does not know
    // the node's TYPE — so a code mapped to two tabs lights up BOTH of
    // them for any node reachable from both, whether or not that node
    // actually renders the offending field there. A button's Content tab
    // (ButtonContent) renders only its label, not the ActionField — that
    // lives on Binding (see below) — so mapping EMPTY_ACTION_URL here too
    // would put a dot on a button's Content tab pointing at nothing to
    // fix. See Binding's issueCodes comment for the resulting trade-off.
    issueCodes: new Set<BuilderIssue["code"]>([
      "UNKNOWN_LOC_KEY",
      "EMPTY_LOC_VALUE",
      "VIDEO_AUTOPLAY_UNMUTED",
      "VIDEO_NO_POSTER",
      "LOTTIE_SPEED_OUT_OF_RANGE",
      "EMPTY_MEDIA_URL",
    ]),
  },
  {
    id: "binding",
    fallbackLabel: "Binding",
    appliesTo: new Set<PaywallNode["type"]>(["button", "packageList", "purchaseButton"]),
    // EMPTY_ACTION_URL is mapped ONLY here, not also to Content, even
    // though a footerLinks link's action is edited on Content
    // (FooterLinksContent's ActionField) and footerLinks — the template
    // footer factory's Terms/Privacy links are this code's primary
    // motivating case — has no Binding tab at all (see appliesTo above),
    // so a footerLinks node carrying this issue gets no per-tab dot here.
    // That is a deliberate, CELL_TEMPLATE_BAD_NODE-style trade: `tabIssues`
    // has no node-type awareness, so mapping to both tabs would light up a
    // BUTTON's Content tab too — a dot pointing at a tab (ButtonContent)
    // that renders no action field at all, which is worse than a missing
    // dot. The validation drawer remains the complete, node-scoped list
    // either way.
    issueCodes: new Set<BuilderIssue["code"]>(["FOREIGN_PACKAGE_ID", "EMPTY_ACTION_URL"]),
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
      "divider",
      "icon",
      "featureList",
      "timeline",
      "socialProof",
      "stickyFooter",
      "countdown",
      "carousel",
      "video",
      "lottie",
      "footerLinks",
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
