// =============================================================
// Pure paywall-ui helpers. resolveVariables + PackageView come
// straight from @rovenue/shared/paywall (bundled into dist by
// tsup like the rest of the shared dependency); the tree-aware
// helpers below are local because they must understand the
// lenient model's `unknown` nodes.
// =============================================================

import { resolveVariables, type PackageView } from "@rovenue/shared/paywall";
import type { Offering, Period, StoreProduct } from "../types";
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

function periodLabel(period: Period | null | undefined): string {
  return period?.unit ?? "";
}

/**
 * `pricePerWeek / 7`, formatted with the product's own currency — `undefined`
 * unless both a numeric `pricePerWeek` and a `currencyCode` are present on
 * `product`. Uses `Intl.NumberFormat("en-US", ...)` (RN's own formatting
 * primitive — no `Decimal`/`BigDecimal` equivalent), self-consistent with
 * the Kotlin sibling's `Locale.US` `NumberFormat`.
 */
function pricePerDayString(product: StoreProduct | null): string | undefined {
  const weekly = product?.pricePerWeek;
  const currencyCode = product?.currencyCode;
  if (weekly == null || currencyCode == null) return undefined;
  const daily = weekly / 7;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode }).format(daily);
}

/**
 * `round((1 − pricePerYearEquivalent / maxPricePerYearEquivalent) × 100)%`
 * across `offering`'s packages with a numeric `pricePerYear` — `undefined`
 * when `product` has no numeric `pricePerYear`, `offering` is absent, or
 * fewer than 2 packages in `offering` are comparable (have a numeric
 * `pricePerYear` of their own). Mirrors the cross-platform D3 spec formula
 * (identical to Swift's/Kotlin's `relativeDiscount`).
 */
function relativeDiscount(product: StoreProduct | null, offering: Offering | null | undefined): string | undefined {
  const ownYearPrice = product?.pricePerYear;
  if (ownYearPrice == null || !offering) return undefined;
  const comparable = offering.packages
    .map((p) => p.product.pricePerYear)
    .filter((v): v is number => v != null);
  if (comparable.length < 2) return undefined;
  const maxYearPrice = Math.max(...comparable);
  if (!(maxYearPrice > 0)) return undefined;
  const rounded = Math.round((1 - ownYearPrice / maxYearPrice) * 100);
  return `${rounded}%`;
}

/**
 * The normative cross-platform PackageView formula (identical to Swift's
 * PackageViewMapping.swift and Kotlin's PackageViewMapping.kt):
 * packageName = displayName; price = priceString ?? ""; period = the
 * subscription period's unit label or "" for non-subscriptions;
 * pricePerPeriod = price alone when period is empty, else "price/period".
 *
 * Phase D3 optional fields (all `undefined` when not derivable, which
 * `resolveVariables` treats identically to an unconfigured variable):
 * `pricePerWeek`/`pricePerMonth`/`pricePerYear` pass through the
 * product's own `pricePerWeekString`/`pricePerMonthString`/
 * `pricePerYearString` verbatim; `pricePerDay` derives from numeric
 * `pricePerWeek`/7 (see `pricePerDayString`); `introPrice`/`introPeriod`
 * come from `product.introPrice`; `relativeDiscount` compares against
 * `offering`'s other packages (see `relativeDiscount`) — `offering` is
 * optional since a `packageList` cell isn't always rendered with one.
 */
export function packageView(
  product: StoreProduct | null,
  displayName: string,
  offering?: Offering | null,
): PackageView {
  const price = product?.priceString ?? "";
  const period = periodLabel(product?.subscriptionPeriod);
  return {
    packageName: displayName,
    price,
    pricePerPeriod: period === "" ? price : `${price}/${period}`,
    period,
    pricePerDay: pricePerDayString(product),
    pricePerWeek: product?.pricePerWeekString ?? undefined,
    pricePerMonth: product?.pricePerMonthString ?? undefined,
    pricePerYear: product?.pricePerYearString ?? undefined,
    introPrice: product?.introPrice?.priceString ?? undefined,
    introPeriod: product?.introPrice ? periodLabel(product.introPrice.period) : undefined,
    relativeDiscount: relativeDiscount(product, offering),
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
