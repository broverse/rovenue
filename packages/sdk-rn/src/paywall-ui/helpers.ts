// =============================================================
// Pure paywall-ui helpers. resolveVariables + PackageView come
// straight from @rovenue/shared/paywall (bundled into dist by
// tsup like the rest of the shared dependency); the tree-aware
// helpers below are local because they must understand the
// lenient model's `unknown` nodes.
// =============================================================

import { resolveVariables, type PackageView } from "@rovenue/shared/paywall";
import type { Offering, StoreProduct } from "../types";
import type { BuilderConfigModel, BuilderNode } from "./model";

export { resolveVariables };
export type { PackageView };

/**
 * Locale → defaultLocale → null chain; an empty-string value is a VALID
 * hit. Mirrors @rovenue/shared/paywall's resolveText (local because the
 * shared one is typed against the strict schema's BuilderConfig).
 */
export function resolveText(
  config: BuilderConfigModel,
  locale: string | undefined,
  key: string,
): string | null {
  const requested = locale ? config.localizations[locale] : undefined;
  if (requested && Object.prototype.hasOwnProperty.call(requested, key)) {
    return requested[key]!;
  }
  const fallback = config.localizations[config.defaultLocale];
  if (fallback && Object.prototype.hasOwnProperty.call(fallback, key)) {
    return fallback[key]!;
  }
  return null;
}

/**
 * The normative cross-platform PackageView formula (identical to Swift's
 * PackageViewMapping.swift and Kotlin's PackageViewMapping.kt):
 * packageName = displayName; price = priceString ?? ""; period = the
 * subscription period's unit label or "" for non-subscriptions;
 * pricePerPeriod = price alone when period is empty, else "price/period".
 */
export function packageView(product: StoreProduct | null, displayName: string): PackageView {
  const price = product?.priceString ?? "";
  const period = product?.subscriptionPeriod?.unit ?? "";
  return {
    packageName: displayName,
    price,
    pricePerPeriod: period === "" ? price : `${price}/${period}`,
    period,
  };
}

/** Empty `packageIds` means "every offering package" (schema semantics). */
export function effectivePackageIds(
  node: Extract<BuilderNode, { type: "packageList" }>,
  offering: Offering | null,
): string[] {
  if (node.packageIds.length > 0) return node.packageIds;
  return offering?.packages.map((p) => p.identifier) ?? [];
}

/** Depth-first over the PRIMARY tree (fallback subtrees excluded). */
function findFirstPackageList(
  node: BuilderNode,
): Extract<BuilderNode, { type: "packageList" }> | null {
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
 * Initial selection: the first packageList's non-empty `defaultSelected`,
 * else the first effective package id, else null.
 */
export function initialSelection(root: BuilderNode, offering: Offering | null): string | null {
  const list = findFirstPackageList(root);
  if (!list) return null;
  if (list.defaultSelected) return list.defaultSelected;
  return effectivePackageIds(list, offering)[0] ?? null;
}

/** Dark side of a theme pair only in dark mode AND when present. */
export function themeValue(pair: { light: string; dark?: string }, dark: boolean): string {
  return dark && pair.dark ? pair.dark : pair.light;
}
