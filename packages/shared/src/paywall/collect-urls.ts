import { OVERRIDABLE_PROP_KEYS, type BuilderConfig, type PaywallNode, type ThemeUrl } from "./schema";

// =============================================================
// collectMediaUrls — every media URL a published paywall version
// references, deduplicated
// =============================================================
//
// This feeds the asset usage index (design spec §7): at publish time,
// every URL this returns is resolved back to an asset id and recorded
// against the version, so the dashboard can warn "N published paywalls
// use this" before an asset is deleted out from under a live paywall.
//
// A URL this walk misses is an asset that silently reports zero usage —
// exactly the report that lets someone delete it while a live paywall
// still serves it. So this covers, deliberately:
//   - `image` nodes: `url.light` and `url.dark`
//   - `video` nodes: `url.light`/`url.dark` and `posterUrl.light`/`.dark`
//   - `lottie` nodes: `url.light`/`url.dark`
//   - every node nested arbitrarily deep inside a container's `children`
//   - `packageList.cellTemplate` subtrees (same node shapes, same rules)
//   - every node's `fallback` subtree (rendered in place of the primary
//     node, so it is exactly as real a render target)
//   - conditional `overrides` — `OVERRIDABLE_PROP_KEYS.video` includes
//     `url` and `posterUrl`, and `OVERRIDABLE_PROP_KEYS.lottie` includes
//     `url`, so an override can introduce a URL the base props never
//     mention. This constant is read directly off `OVERRIDABLE_PROP_KEYS`
//     (not hand-copied) so a future schema change to the overridable set
//     can't silently drift out of sync with this walk.

/** Node types (and the subset of their overridable keys) whose override
 *  `props` can carry a `ThemeUrl` value — derived from `OVERRIDABLE_PROP_KEYS`
 *  itself rather than restated, since for both of these node types every
 *  overridable key IS a URL field. */
const URL_OVERRIDE_KEYS: Partial<Record<PaywallNode["type"], readonly string[]>> = {
  video: OVERRIDABLE_PROP_KEYS.video,
  lottie: OVERRIDABLE_PROP_KEYS.lottie,
};

function isThemeUrl(value: unknown): value is ThemeUrl {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { light?: unknown }).light === "string"
  );
}

function addThemeUrl(urls: Set<string>, url: ThemeUrl | undefined | null): void {
  if (!url) return;
  if (url.light) urls.add(url.light);
  if (url.dark) urls.add(url.dark);
}

function addOverrideUrls(node: PaywallNode, urls: Set<string>): void {
  const urlKeys = URL_OVERRIDE_KEYS[node.type];
  if (!urlKeys || !node.overrides) return;
  for (const override of node.overrides) {
    for (const key of urlKeys) {
      const value = override.props[key];
      if (isThemeUrl(value)) addThemeUrl(urls, value);
    }
  }
}

function walk(node: PaywallNode, urls: Set<string>): void {
  switch (node.type) {
    case "stack":
    case "stickyFooter":
    case "carousel":
      for (const child of node.children) walk(child, urls);
      break;
    case "image":
      addThemeUrl(urls, node.url);
      break;
    case "video":
      addThemeUrl(urls, node.url);
      addThemeUrl(urls, node.posterUrl);
      break;
    case "lottie":
      addThemeUrl(urls, node.url);
      break;
    case "packageList":
      if (node.cellTemplate) walk(node.cellTemplate, urls);
      break;
    case "text":
    case "button":
    case "purchaseButton":
    case "spacer":
    case "divider":
    case "icon":
    case "featureList":
    case "timeline":
    case "socialProof":
    case "countdown":
      break;
    default: {
      // Exhaustiveness guard: a new PaywallNode variant that isn't wired
      // in above fails the build here rather than silently walking past it.
      const exhaustive: never = node;
      void exhaustive;
    }
  }

  addOverrideUrls(node, urls);

  if (node.fallback) walk(node.fallback, urls);
}

/**
 * Every media URL referenced by `config`'s node tree, deduplicated.
 * `config` may be `null`/`undefined` (a paywall version can be created
 * with a null `builderConfig`, e.g. Phase A remote-config-only paywalls),
 * in which case this returns an empty list.
 */
export function collectMediaUrls(config: BuilderConfig | null | undefined): string[] {
  const urls = new Set<string>();
  if (config?.root) walk(config.root, urls);
  return [...urls];
}
