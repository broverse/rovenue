import type { BuilderConfig, PaywallNode, StackNode } from "@rovenue/shared/paywall";

// =============================================================
// Section factories behind the template catalogue. Every template is a
// composition of these, so a template is a short list of sections plus
// its copy rather than a 120-line object literal.
//
// Three constraints hold for EVERY factory, and `templates.test.ts`
// enforces all three over the whole catalogue:
//   1. No package ids and no `defaultSelected` -- `packageIds: []` means
//      "every package in the offering", so a template validates against
//      ANY offering (FOREIGN_PACKAGE_ID rejects anything else).
//   2. No asset URLs. Asset-CDN URLs are `{projectId}/{assetId}.{ext}`,
//      so a baked URL would point every project at one project's private
//      prefix. Image/video nodes ship `{ light: "" }` -- a placeholder the
//      author replaces, allowed at save and caught by the publish gate.
//   3. Every locale key a factory's nodes reference gets a value in the
//      same factory's `copy`.
// =============================================================

/** One composable slice of a template: the nodes it contributes to the
 *  root stack, and the locale copy those nodes' keys resolve to. Every
 *  factory below namespaces both its node ids and its locale keys with
 *  its own `id` param, so composing two of the same section (two
 *  `headline`s, say) can never collide -- see `compose`. */
export type Section = { nodes: PaywallNode[]; copy: Record<string, string> };

// -------------------------------------------------------------
// Root stack shape. Copied from `presets.ts`'s `root()` helper rather than
// imported -- `presets.ts` is retired by Task 9, and importing from a file
// about to be deleted would leave this kit dangling. Task 9 deletes the
// duplicate.
// -------------------------------------------------------------

/** Vertical gap between the root stack's direct children. */
const TEMPLATE_ROOT_SPACING = 16;
/** Outer padding of the root stack: top, right, bottom, left. */
const TEMPLATE_ROOT_PADDING = { t: 24, r: 20, b: 24, l: 20 };

/** Default height (px) for a `heroImage` section's placeholder image,
 *  matching `presets.ts`'s `hero` preset. */
const HERO_IMAGE_DEFAULT_HEIGHT = 220;
/** Default corner radius (px) for a `heroImage` section's placeholder image,
 *  matching `presets.ts`'s `hero` preset. */
const HERO_IMAGE_DEFAULT_CORNER_RADIUS = 16;

function heroImage(p: { id: string; height?: number }): Section {
  const nodes: PaywallNode[] = [
    {
      type: "image",
      id: `${p.id}_image`,
      url: { light: "" }, // placeholder -- see constraint 2 above
      height: p.height ?? HERO_IMAGE_DEFAULT_HEIGHT,
      cornerRadius: HERO_IMAGE_DEFAULT_CORNER_RADIUS,
    },
  ];
  return { nodes, copy: {} }; // image contributes no localized keys
}

function headline(p: { id: string; title: string; subtitle?: string }): Section {
  const titleKey = `${p.id}_title`;
  const subtitleKey = `${p.id}_subtitle`;
  const nodes: PaywallNode[] = [
    { type: "text", id: titleKey, key: titleKey, role: "title", align: "center" },
  ];
  const copy: Record<string, string> = { [titleKey]: p.title };
  if (p.subtitle !== undefined) {
    nodes.push({ type: "text", id: subtitleKey, key: subtitleKey, role: "subtitle", align: "center" });
    copy[subtitleKey] = p.subtitle;
  }
  return { nodes, copy };
}

function featureRows(p: { id: string; rows: string[] }): Section {
  const copy: Record<string, string> = {};
  const rows = p.rows.map((label, i) => {
    const key = `${p.id}_row_${i + 1}`;
    copy[key] = label;
    return { labelKey: key };
  });
  const nodes: PaywallNode[] = [{ type: "featureList", id: `${p.id}_list`, rows }];
  return { nodes, copy };
}

function trialTimeline(p: { id: string; steps: Array<{ label: string; caption?: string }> }): Section {
  const copy: Record<string, string> = {};
  const rows = p.steps.map((step, i) => {
    const labelKey = `${p.id}_step_${i + 1}_label`;
    copy[labelKey] = step.label;
    if (step.caption === undefined) return { labelKey };
    const captionKey = `${p.id}_step_${i + 1}_caption`;
    copy[captionKey] = step.caption;
    return { labelKey, captionKey };
  });
  const nodes: PaywallNode[] = [{ type: "timeline", id: `${p.id}_timeline`, rows }];
  return { nodes, copy };
}

function packages(p: { id: string; layout: "row" | "column" }): Section {
  // packageIds: [] -- "every package in the offering" (constraint 1); no
  // defaultSelected, so no package name is baked into the template.
  const nodes: PaywallNode[] = [
    { type: "packageList", id: `${p.id}_list`, packageIds: [], cellLayout: p.layout },
  ];
  return { nodes, copy: {} }; // packageList contributes no localized keys
}

function purchaseCta(p: { id: string; label: string; trialLabel?: string }): Section {
  const labelKey = `${p.id}_label`;
  const trialLabelKey = `${p.id}_trial_label`;
  const copy: Record<string, string> = { [labelKey]: p.label };
  if (p.trialLabel !== undefined) copy[trialLabelKey] = p.trialLabel;
  const nodes: PaywallNode[] = [
    {
      type: "purchaseButton",
      id: `${p.id}_button`,
      labelKey,
      ...(p.trialLabel !== undefined ? { trialLabelKey } : {}),
    },
  ];
  return { nodes, copy };
}

function socialProof(p: { id: string; label: string; rating?: number }): Section {
  const labelKey = `${p.id}_label`;
  const nodes: PaywallNode[] = [
    { type: "socialProof", id: `${p.id}_proof`, labelKey, rating: p.rating },
  ];
  return { nodes, copy: { [labelKey]: p.label } };
}

function countdownBanner(p: { id: string; label: string; seconds: number }): Section {
  const labelKey = `${p.id}_label`;
  const nodes: PaywallNode[] = [
    {
      type: "countdown",
      id: `${p.id}_countdown`,
      // `durationSeconds`, not `endsAt` -- an absolute deadline would be
      // fixed the moment the template is authored, so every paywall
      // created from it would share one countdown to a date in the past.
      // `durationSeconds` anchors from first-show instead.
      durationSeconds: p.seconds,
      labelKey,
    },
  ];
  return { nodes, copy: { [labelKey]: p.label } };
}

function screenshotCarousel(p: { id: string; slides: number }): Section {
  const nodes: PaywallNode[] = [
    {
      type: "carousel",
      id: `${p.id}_carousel`,
      children: Array.from({ length: p.slides }, (_, i) => ({
        type: "image" as const,
        id: `${p.id}_slide_${i + 1}`,
        url: { light: "" }, // placeholder -- see constraint 2 above
      })),
    },
  ];
  return { nodes, copy: {} }; // carousel pages (images) contribute no keys
}

function videoHero(p: { id: string }): Section {
  const nodes: PaywallNode[] = [
    { type: "video", id: `${p.id}_video`, url: { light: "" } }, // placeholder -- see constraint 2 above
  ];
  return { nodes, copy: {} }; // video contributes no localized keys
}

/**
 * The footer's Terms/Privacy links carry `{ kind: "url", url: "" }` rather
 * than a fabricated domain: a template cannot know the project's real
 * legal URLs, and `{ light: "" }` is already the kit's placeholder
 * convention for a value the author must fill in (constraint 2's asset
 * URLs). Restore uses the dedicated `{ kind: "restore" }` action, which
 * needs no URL and works unmodified for every project.
 */
function footer(p: { id: string; restore: string; terms: string; privacy: string }): Section {
  const restoreKey = `${p.id}_restore`;
  const termsKey = `${p.id}_terms`;
  const privacyKey = `${p.id}_privacy`;
  const nodes: PaywallNode[] = [
    {
      type: "footerLinks",
      id: `${p.id}_links`,
      links: [
        { labelKey: restoreKey, action: { kind: "restore" } },
        { labelKey: termsKey, action: { kind: "url", url: "" } },
        { labelKey: privacyKey, action: { kind: "url", url: "" } },
      ],
    },
  ];
  return {
    nodes,
    copy: { [restoreKey]: p.restore, [termsKey]: p.terms, [privacyKey]: p.privacy },
  };
}

function spacer(p: { id: string; size?: number }): Section {
  const nodes: PaywallNode[] = [{ type: "spacer", id: `${p.id}_spacer`, size: p.size }];
  return { nodes, copy: {} }; // spacer contributes no localized keys
}

/**
 * Builds the root stack from every section's nodes in order, and merges
 * every section's `copy` into `localizations[defaultLocale]`. Later
 * sections win on a key collision (there should never be one, since every
 * factory namespaces its keys by its own `id`).
 */
function compose(defaultLocale: string, sections: Section[]): BuilderConfig {
  const children: PaywallNode[] = sections.flatMap((s) => s.nodes);
  const copy: Record<string, string> = {};
  for (const section of sections) Object.assign(copy, section.copy);

  const root: StackNode = {
    type: "stack",
    id: "root",
    axis: "v",
    spacing: TEMPLATE_ROOT_SPACING,
    padding: TEMPLATE_ROOT_PADDING,
    children,
  };

  return { formatVersion: 2, defaultLocale, localizations: { [defaultLocale]: copy }, root };
}

export {
  compose,
  countdownBanner,
  featureRows,
  footer,
  headline,
  heroImage,
  packages,
  purchaseCta,
  screenshotCarousel,
  socialProof,
  spacer,
  trialTimeline,
  videoHero,
};
