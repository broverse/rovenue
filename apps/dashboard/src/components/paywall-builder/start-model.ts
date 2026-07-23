import type { BuilderConfig, PaywallNode } from "@rovenue/shared/paywall";

// =============================================================
// Pure helpers behind the start gallery. The card preview is derived
// from a preset's OWN node tree rather than hand-drawn per template,
// so a newly-added preset gets a silhouette for free.
// =============================================================

/** One band in a card's silhouette. */
export type PreviewBlock =
  | { kind: "media" }
  | { kind: "line"; width: number }
  | { kind: "cells" }
  | { kind: "action" }
  | { kind: "gap" };

/**
 * Bar width per text role, as a fraction of the card width — so the
 * silhouette reads like a paywall instead of a stack of identical bars.
 */
const LINE_WIDTH_BY_ROLE: Record<string, number> = {
  title: 0.8,
  subtitle: 0.65,
  body: 0.7,
  caption: 0.5,
};
/** Fallback width for a text node whose role isn't in the table. */
const LINE_WIDTH_DEFAULT = 0.7;

function blockFor(node: PaywallNode): PreviewBlock | null {
  switch (node.type) {
    case "image":
      return { kind: "media" };
    case "text":
      return { kind: "line", width: LINE_WIDTH_BY_ROLE[node.role] ?? LINE_WIDTH_DEFAULT };
    case "packageList":
      return { kind: "cells" };
    case "purchaseButton":
    case "button":
      return { kind: "action" };
    case "spacer":
      return { kind: "gap" };
    default:
      // A silhouette, not a rendering — nested structure is ignored.
      return null;
  }
}

/** The root's DIRECT children as silhouette bands, in document order. */
export function previewBlocks(config: BuilderConfig): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  for (const child of config.root.children) {
    const block = blockFor(child);
    if (block) blocks.push(block);
  }
  return blocks;
}

/** True when there is nothing in the tree yet — the "just created it" moment. */
export function shouldAutoOpenStart(config: BuilderConfig): boolean {
  return config.root.children.length === 0;
}
