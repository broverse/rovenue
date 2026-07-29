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

// =============================================================
// Node style pass (border / background / labelColor / cornerRadius, spec
// 2026-07-29). Mirrors packages/paywall-renderer/src/styles.ts's own pure
// helpers (`borderStyle`, `resolveButtonVisualStyle`) — same precedence
// rule (custom always wins, absent leaves the base/variant untouched), same
// "skip rather than guess" leniency on an unparsable color as the rest of
// this file. All additive: every helper below returns exactly what the
// pre-existing call sites produced when the new props are absent, which is
// the regression pin this wave requires.
// =============================================================

/// A border resolved for the active color scheme. `nil` when `border`
/// itself is absent OR its color fails to parse — mirrors `parseHexColor`'s
/// own "skip, don't guess" contract; there is no default border to fall
/// back to; absent means no border, today's output.
public struct ResolvedBorder: Equatable, Sendable {
    public let width: Double
    public let color: RGBAColor

    public init(width: Double, color: RGBAColor) {
        self.width = width
        self.color = color
    }
}

/// Resolves a `NodeBorder?` against the active color scheme. Drawn INSIDE
/// the node's own `cornerRadius` at every call site — this helper only
/// resolves the color/width, the caller supplies the shared radius.
public func resolveBorder(_ border: NodeBorder?, dark: Bool) -> ResolvedBorder? {
    guard let border, let rgba = parseHexColor(themeValue(border.color, dark: dark)) else { return nil }
    return ResolvedBorder(width: border.width, color: rgba)
}

/// The visual a button/purchaseButton draws before any of its own custom
/// style props are considered. On this platform NEITHER node type has ever
/// drawn a background/label-color/border from anything but this base — for
/// `button` that base is "nothing" (the SwiftUI `Button` default look,
/// `ActionButtonView` never painted one), for `purchaseButton` it is the
/// fixed accent-color chip `PurchaseButtonView` has always drawn. Passing
/// `ButtonBaseVisual()` (all `nil`) is therefore the correct base for
/// `button`; `purchaseButton`'s own base is assembled at its call site
/// because it depends on `enabled`, which this pure helper has no way to
/// know about.
public struct ButtonBaseVisual: Equatable, Sendable {
    public let background: RGBAColor?
    public let labelColor: RGBAColor?
    public let border: ResolvedBorder?

    public init(background: RGBAColor? = nil, labelColor: RGBAColor? = nil, border: ResolvedBorder? = nil) {
        self.background = background
        self.labelColor = labelColor
        self.border = border
    }
}

/// The subset of `ButtonProps`/`PurchaseButtonProps` this wave added — both
/// node payload structs carry these four fields with identical names/types,
/// so one shape covers either caller.
public struct ButtonCustomStyleProps: Equatable, Sendable {
    public let background: ThemePair?
    public let labelColor: ThemePair?
    public let border: NodeBorder?
    public let cornerRadius: Double?

    public init(background: ThemePair? = nil, labelColor: ThemePair? = nil, border: NodeBorder? = nil,
                cornerRadius: Double? = nil) {
        self.background = background
        self.labelColor = labelColor
        self.border = border
        self.cornerRadius = cornerRadius
    }
}

/// A button/purchaseButton's fully-resolved visual, ready to hand to
/// SwiftUI modifiers.
public struct ResolvedButtonVisual: Equatable, Sendable {
    public let background: RGBAColor?
    public let labelColor: RGBAColor?
    public let border: ResolvedBorder?
    public let cornerRadius: Double

    public init(background: RGBAColor?, labelColor: RGBAColor?, border: ResolvedBorder?, cornerRadius: Double) {
        self.background = background
        self.labelColor = labelColor
        self.border = border
        self.cornerRadius = cornerRadius
    }
}

/// `ActionButtonView`'s shared default corner radius for a chip that gains
/// one for the first time because a custom style prop made it visible —
/// mirrors the web renderer's `NODE_BUTTON_DEFAULT_CORNER_RADIUS_PX` (8).
/// `PurchaseButtonView` does NOT use this constant: unlike `button`, it has
/// drawn its own 12pt chip since before this wave, regardless of any new
/// prop, and that pre-existing value is its own default (see
/// `RovenuePaywallView.swift`'s `purchaseButtonDefaultCornerRadiusPx`) —
/// switching it to 8 here would violate the regression pin.
public let nodeButtonDefaultCornerRadiusPx = 8.0

/// Merge a button/purchaseButton's base visual with its own optional custom
/// style props (mirrors the web renderer's `resolveButtonVisualStyle`).
/// Custom always wins; an absent custom prop leaves `base`'s own value
/// untouched — the regression pin: a node with none of the four new props
/// produces exactly `base`, unchanged in `background`/`labelColor`/`border`,
/// with `cornerRadius` resolving to `defaultCornerRadius` (the caller's own
/// literal — see `nodeButtonDefaultCornerRadiusPx`'s doc comment for why
/// button and purchaseButton do not share one).
public func resolveButtonVisual(
    base: ButtonBaseVisual,
    custom: ButtonCustomStyleProps,
    defaultCornerRadius: Double,
    dark: Bool
) -> ResolvedButtonVisual {
    let customBackground = custom.background.flatMap { parseHexColor(themeValue($0, dark: dark)) }
    let customLabelColor = custom.labelColor.flatMap { parseHexColor(themeValue($0, dark: dark)) }
    return ResolvedButtonVisual(
        background: customBackground ?? base.background,
        labelColor: customLabelColor ?? base.labelColor,
        border: resolveBorder(custom.border, dark: dark) ?? base.border,
        cornerRadius: custom.cornerRadius ?? defaultCornerRadius
    )
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
