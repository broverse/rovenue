//
//  PaywallRenderSupport.swift
//  Pure, unit-testable pieces backing RovenuePaywallView — kept out of the
//  SwiftUI bodies so the render rules stay assertable without a UI test
//  harness (house rule: view bodies thin, logic in pure helpers).
//

import Foundation

/// Parsed sRGB components in 0...1. Alpha defaults to 1.
public struct RGBAColor: Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double
    public let alpha: Double
}

/// Parses `#RRGGBB` or `#RRGGBBAA` (leading `#` optional, case-insensitive —
/// the dashboard's color inputs emit `#RRGGBB`). Anything else → `nil`; the
/// renderer skips unparseable colors rather than guessing.
public func parseHexColor(_ raw: String) -> RGBAColor? {
    var hex = raw.trimmingCharacters(in: .whitespaces)
    if hex.hasPrefix("#") { hex.removeFirst() }
    guard hex.count == 6 || hex.count == 8,
          hex.allSatisfy({ $0.isHexDigit }),
          let value = UInt64(hex, radix: 16)
    else { return nil }

    if hex.count == 6 {
        return RGBAColor(
            red: Double((value >> 16) & 0xFF) / 255.0,
            green: Double((value >> 8) & 0xFF) / 255.0,
            blue: Double(value & 0xFF) / 255.0,
            alpha: 1.0
        )
    }
    return RGBAColor(
        red: Double((value >> 24) & 0xFF) / 255.0,
        green: Double((value >> 16) & 0xFF) / 255.0,
        blue: Double((value >> 8) & 0xFF) / 255.0,
        alpha: Double(value & 0xFF) / 255.0
    )
}

/// Picks the side of a theme pair for the effective scheme: dark when dark
/// mode AND a dark value exists, else light (mirrors the web renderer).
public func themeValue(_ pair: ThemePair, dark: Bool) -> String {
    if dark, let d = pair.dark { return d }
    return pair.light
}

/// The purchase button is tappable only with a live selection and no
/// purchase already in flight (mirrors the web renderer's disabled rule).
public func purchaseEnabled(selectedPackageId: String?, isPurchasing: Bool) -> Bool {
    selectedPackageId != nil && !isPurchasing
}

/// Whether an action button renders at all. Restore buttons are HIDDEN when
/// the host supplies no restore handler (web-renderer parity — e.g. the
/// funnel context has no restore concept); every other action stays visible
/// even handler-less (inert).
public func actionButtonVisible(_ action: ButtonAction, hasRestoreHandler: Bool) -> Bool {
    if case .restore = action { return hasRestoreHandler }
    return true
}

/// PackageView for the currently relevant package: the cell's own package
/// inside a packageList cell, else the selected one. `nil` leaves variables
/// verbatim (resolveVariables contract).
public func relevantPackageView(
    cell: PackageView?,
    selectedPackageId: String?,
    offering: Offering?
) -> PackageView? {
    if let cell { return cell }
    guard let id = selectedPackageId,
          let pkg = offering?.packages.first(where: { $0.identifier == id })
    else { return nil }
    return packageView(from: pkg.product, displayName: pkg.product.displayName, offering: offering)
}
