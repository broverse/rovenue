//  PackageViewMapping.swift — StoreProduct -> PackageView mapping, and the
//  pure package-selection helpers (`effectivePackageIds` / `initialSelection`)
//  shared with the web renderer (packages/paywall-renderer/src/{nodes,renderer}.tsx)
//  and the Kotlin façade. Selection semantics are ported from
//  `initialSelectedPackageId` / `effectivePackageIds` in renderer.tsx /
//  nodes.tsx — see renderer.test.tsx's "selection" describe block for the
//  behavior these mirror.

import Foundation

/// Maps a `StoreProduct` (optional — a `packageList` cell may reference a
/// package id that isn't hydrated) to its `PackageView`. `displayName` is
/// supplied by the caller (the owning `Package`'s display name) rather than
/// read off `product`, since the product itself carries no package-level
/// display name. `offering`, when supplied, provides the sibling packages
/// `relativeDiscount` compares against (see `relativeDiscount(for:in:)`) —
/// omit it (or pass `nil`) when no offering context is available; every
/// other field is derivable from `product` alone.
///
/// Mapping (normative, identical to the Kotlin façade):
/// - `packageName` = `displayName`
/// - `price` = `product?.priceString ?? ""`
/// - `period` = the subscription period's unit label (`"day"`/`"week"`/
///   `"month"`/`"year"`), or `""` for a non-subscription product (nil
///   `subscriptionPeriod`)
/// - `pricePerPeriod` = `period.isEmpty ? price : "\(price)/\(period)"`
///
/// Phase D3 optional fields:
/// - `pricePerWeek`/`pricePerMonth`/`pricePerYear` = the enriched product's
///   own `pricePerWeekString`/`pricePerMonthString`/`pricePerYearString`
///   verbatim.
/// - `pricePerDay` = `pricePerWeek / 7`, formatted with the product's own
///   currency — ONLY when both a numeric `pricePerWeek` and a
///   `currencyCode` exist on the product; `nil` otherwise (no per-day
///   figure to derive, or no currency to format it with).
/// - `introPrice`/`introPeriod` = `product.introPrice`'s `priceString` and
///   period unit label (`periodLabel`, same helper as the required `period`
///   field) — both `nil` when the product has no intro offer.
/// - `relativeDiscount` = see `relativeDiscount(for:in:)`.
public func packageView(from product: StoreProduct?, displayName: String, offering: Offering? = nil) -> PackageView {
    let price = product?.priceString ?? ""
    let period = periodLabel(product?.subscriptionPeriod)
    let pricePerPeriod = period.isEmpty ? price : "\(price)/\(period)"
    return PackageView(
        packageName: displayName, price: price, pricePerPeriod: pricePerPeriod, period: period,
        pricePerDay: pricePerDayString(product),
        pricePerWeek: product?.pricePerWeekString,
        pricePerMonth: product?.pricePerMonthString,
        pricePerYear: product?.pricePerYearString,
        introPrice: product?.introPrice?.priceString,
        introPeriod: product?.introPrice.map { periodLabel($0.period) },
        relativeDiscount: relativeDiscount(for: product, in: offering))
}

private func periodLabel(_ period: Period?) -> String {
    guard let period else { return "" }
    switch period.unit {
    case .day: return "day"
    case .week: return "week"
    case .month: return "month"
    case .year: return "year"
    }
}

/// `pricePerWeek / 7`, formatted with the product's own currency — `nil`
/// unless both a numeric `pricePerWeek` and a `currencyCode` are present.
private func pricePerDayString(_ product: StoreProduct?) -> String? {
    guard let weekly = product?.pricePerWeek, let currencyCode = product?.currencyCode else { return nil }
    let daily = weekly / 7
    return daily.formatted(.currency(code: currencyCode))
}

/// `round((1 − pricePerYearEquivalent / maxPricePerYearEquivalent) × 100)%`
/// across `offering`'s packages with a numeric `pricePerYear` — `nil` when
/// `product` has no numeric `pricePerYear`, `offering` is absent, or fewer
/// than 2 packages in `offering` are comparable (have a numeric
/// `pricePerYear` of their own). Mirrors the cross-platform D3 spec formula.
private func relativeDiscount(for product: StoreProduct?, in offering: Offering?) -> String? {
    guard let ownYearPrice = product?.pricePerYear, let offering else { return nil }
    let comparable = offering.packages.compactMap { $0.product.pricePerYear }
    guard comparable.count >= 2, let maxYearPrice = comparable.max(), maxYearPrice > 0 else { return nil }
    let ratio = (Decimal(1) - ownYearPrice / maxYearPrice) * 100
    let rounded = Int((ratio as NSDecimalNumber).doubleValue.rounded())
    return "\(rounded)%"
}

/// Resolves a `packageList` node's effective package ids: when
/// `node.packageIds` is empty (meaning "all offering packages"), returns
/// every package identifier in `offering`; otherwise returns
/// `node.packageIds` as-is. Mirrors nodes.tsx's `effectivePackageIds`.
public func effectivePackageIds(_ node: PackageListProps, offering: Offering?) -> [String] {
    if !node.packageIds.isEmpty { return node.packageIds }
    return offering?.packages.map(\.identifier) ?? []
}

/// Depth-first search over the PRIMARY tree (not `fallback` subtrees) for
/// the first `packageList` node.
private func findFirstPackageList(_ node: BuilderNode) -> PackageListProps? {
    switch node {
    case .packageList(let props):
        return props
    case .stack(let props):
        for child in props.children {
            if let found = findFirstPackageList(child) {
                return found
            }
        }
        return nil
    default:
        return nil
    }
}

/// Initial package selection, in order: the first `packageList`'s
/// `defaultSelected` (when non-empty), else the first effective package id
/// (rendering all offering packages when `packageIds` is empty), else `nil`.
/// Mirrors renderer.tsx's `initialSelectedPackageId`.
public func initialSelection(_ root: BuilderNode, offering: Offering?) -> String? {
    guard let packageList = findFirstPackageList(root) else {
        return offering?.packages.first?.identifier
    }
    if let defaultSelected = packageList.defaultSelected, !defaultSelected.isEmpty {
        return defaultSelected
    }
    return effectivePackageIds(packageList, offering: offering).first
}
