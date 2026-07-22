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
/// display name.
///
/// Mapping (normative, identical to the Kotlin façade):
/// - `packageName` = `displayName`
/// - `price` = `product?.priceString ?? ""`
/// - `period` = the subscription period's unit label (`"day"`/`"week"`/
///   `"month"`/`"year"`), or `""` for a non-subscription product (nil
///   `subscriptionPeriod`)
/// - `pricePerPeriod` = `period.isEmpty ? price : "\(price)/\(period)"`
public func packageView(from product: StoreProduct?, displayName: String) -> PackageView {
    let price = product?.priceString ?? ""
    let period = periodLabel(product?.subscriptionPeriod)
    let pricePerPeriod = period.isEmpty ? price : "\(price)/\(period)"
    return PackageView(packageName: displayName, price: price, pricePerPeriod: pricePerPeriod, period: period)
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
