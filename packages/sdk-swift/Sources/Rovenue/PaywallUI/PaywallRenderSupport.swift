//
//  PaywallRenderSupport.swift
//  Pure, unit-testable pieces backing RovenuePaywallView — kept out of the
//  SwiftUI bodies so the render rules stay assertable without a UI test
//  harness (house rule: view bodies thin, logic in pure helpers).
//

import CoreGraphics
import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

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

/// `ActionButtonView`'s default corner radius for a chip that gains one for
/// the first time because a custom style prop made it visible — 0 by product
/// decision (2026-07-29): a plain `button` with no `cornerRadius` renders
/// SQUARE; authors opt into rounding. Mirrors the web renderer's
/// `NODE_BUTTON_DEFAULT_CORNER_RADIUS_PX` (0). `PurchaseButtonView` does NOT
/// use this constant: it has drawn its own 12pt chip since before this wave
/// (see `RovenuePaywallView.swift`'s `purchaseButtonDefaultCornerRadiusPx`)
/// and the purchase CTA deliberately keeps that rounded default.
public let nodeButtonDefaultCornerRadiusPx = 0.0

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

// =============================================================
// footerLinks (spec §3 wave, 2026-09-04). Mirrors
// packages/paywall-renderer/src/nodes.tsx's `renderFooterLinks` — the
// normative sibling this ports byte-for-byte on the two rules below.
// =============================================================

/// One footer link that survived BOTH per-link drop rules, carrying its
/// resolved label and its position in the AUTHORED `links` array
/// (`originalIndex`) — not its position among survivors, which shifts
/// between renders (a locale change alters which labels resolve, and
/// `hasRestoreHandler` appearing/disappearing alters whether the restore
/// link survives). Mirrors nodes.tsx's own `originalIndex`-keyed survivor
/// list and its doc comment on why.
public struct FooterLinkSurvivor: Equatable, Sendable {
    public let originalIndex: Int
    public let action: ButtonAction
    public let label: String

    public init(originalIndex: Int, action: ButtonAction, label: String) {
        self.originalIndex = originalIndex
        self.action = action
        self.label = label
    }
}

/// Applies `footerLinks`' two per-link drop rules, in `links` order:
///
///   1. a `restore` link with no restore handler is dropped — calls
///      `actionButtonVisible` (the SAME rule `button` enforces) rather than
///      re-deriving the restore check here.
///   2. a link whose label doesn't resolve anywhere (`resolveLabel` returns
///      `nil`) is dropped.
///
/// Pure and free-standing so the drop rules are testable without a SwiftUI
/// hosting environment — `resolveLabel` is injected rather than reaching
/// into `PaywallRenderContext` directly.
public func footerLinksSurvivors(
    _ links: [FooterLinkModel],
    hasRestoreHandler: Bool,
    resolveLabel: (String) -> String?
) -> [FooterLinkSurvivor] {
    var survivors: [FooterLinkSurvivor] = []
    for (index, link) in links.enumerated() {
        guard actionButtonVisible(link.action, hasRestoreHandler: hasRestoreHandler) else { continue }
        guard let label = resolveLabel(link.labelKey) else { continue }
        survivors.append(FooterLinkSurvivor(originalIndex: index, action: link.action, label: label))
    }
    return survivors
}

/// One entry in a rendered footer row: a survivor's own label, or a
/// separator glyph strictly between two survivors.
public enum FooterRowEntry: Equatable, Sendable {
    case link(FooterLinkSurvivor)
    case separator(String)

    /// The text this entry draws — used for both rendering and (by the
    /// flow layout) width measurement, so a separator's glyph is sized
    /// exactly like any other row text.
    public var text: String {
        switch self {
        case .link(let survivor): return survivor.label
        case .separator(let glyph): return glyph
        }
    }
}

/// Interleaves `survivors` with `glyph`, computed over the SURVIVING links
/// ONLY — never a leading or trailing separator, never two in a row. An
/// empty `glyph` (the `none` separator) never inserts an entry at all.
/// Mirrors nodes.tsx's `renderFooterLinks` loop (`position > 0 && separator
/// !== "none"`).
public func footerRowEntries(survivors: [FooterLinkSurvivor], glyph: String) -> [FooterRowEntry] {
    guard !survivors.isEmpty else { return [] }
    var entries: [FooterRowEntry] = []
    for (position, survivor) in survivors.enumerated() {
        if position > 0, !glyph.isEmpty {
            entries.append(.separator(glyph))
        }
        entries.append(.link(survivor))
    }
    return entries
}

/// The glyph drawn between two surviving links, per `separator`. Same table
/// on all three platforms — mirrors nodes.tsx's `FOOTER_SEPARATOR_GLYPH`
/// (the normative sibling; see render-fixtures.json's `_comment`, which
/// Task 6 wires this node's fixture entries against). An unrecognized or
/// absent `separator` string falls through to
/// `footerLinksDefaultSeparator`'s own glyph — native decoders/renderers
/// are lenient by contract.
public func footerLinkSeparatorGlyph(_ raw: String?) -> String {
    switch raw ?? footerLinksDefaultSeparator {
    case "dot": return "·"
    case "pipe": return "|"
    case "none": return ""
    default: return footerLinkSeparatorGlyph(footerLinksDefaultSeparator)
    }
}

/// Executes a `ButtonAction` against the host's render-context callbacks —
/// the single dispatch point `ActionButtonView` (`button`) and
/// `FooterLinksView` (`footerLinks`) both call, so close/url/restore never
/// drift between the two node types that share this action union. The
/// renderer never navigates itself; hosts decide (and should scheme-check
/// before opening a URL). NOT `public`: `PaywallRenderContext` itself is
/// module-internal (RovenuePaywallView.swift), so this can be no wider.
func performButtonAction(_ action: ButtonAction, ctx: PaywallRenderContext) {
    switch action {
    case .close: ctx.onClose?()
    case .restore: ctx.onRestore?()
    case .url(let raw):
        if let url = URL(string: raw) { ctx.onUrl?(url) }
    }
}

/// The rendered width of `text` at the system font, `fontSize` points —
/// used by `FlowRow` (RovenuePaywallView.swift) to decide `footerLinks`'
/// wrap boundaries analytically, without a GeometryReader-per-child
/// measurement pass: footer-link labels and separator glyphs are always
/// short, plain strings, so sizing them with the system font metrics
/// directly is exact.
public func measuredTextWidth(_ text: String, fontSize: CGFloat) -> CGFloat {
    guard !text.isEmpty else { return 0 }
    #if canImport(UIKit)
    let font = UIFont.systemFont(ofSize: fontSize)
    #elseif canImport(AppKit)
    let font = NSFont.systemFont(ofSize: fontSize)
    #endif
    #if canImport(UIKit) || canImport(AppKit)
    let size = (text as NSString).size(withAttributes: [.font: font])
    return ceil(size.width)
    #else
    // No text system available on this platform — a coarse per-character
    // estimate keeps `computeFlowRows` from dividing by a hard zero rather
    // than matching pixel-for-pixel (this branch never runs on iOS/macOS,
    // the only platforms Package.swift declares).
    return CGFloat(text.count) * fontSize
    #endif
}

/// Which SURVIVING-item indices belong on each wrapped line, given each
/// item's own measured width and the width available. Pure (no SwiftUI
/// dependency) so the wrap boundary itself — not just survivor/glyph
/// selection — is unit-testable: this is the function that decides whether
/// three footer links overflow a 320pt device.
///
/// `spacing` is added BETWEEN items on the same row, never before the
/// first item of a row. An item wider than `containerWidth` on its own
/// still gets its own row rather than being dropped. `containerWidth <= 0`
/// (not yet measured, e.g. the flow view's first SwiftUI render pass)
/// degrades to a single row rather than one row per item, so nothing
/// flashes into a collapsed column before the real width lands.
public func computeFlowRows(itemWidths: [CGFloat], containerWidth: CGFloat, spacing: CGFloat) -> [[Int]] {
    guard !itemWidths.isEmpty else { return [] }
    guard containerWidth > 0 else { return [Array(itemWidths.indices)] }

    var rows: [[Int]] = []
    var currentRow: [Int] = []
    var currentRowWidth: CGFloat = 0
    for (index, width) in itemWidths.enumerated() {
        let additional = currentRow.isEmpty ? width : width + spacing
        if !currentRow.isEmpty, currentRowWidth + additional > containerWidth {
            rows.append(currentRow)
            currentRow = [index]
            currentRowWidth = width
        } else {
            currentRow.append(index)
            currentRowWidth += additional
        }
    }
    rows.append(currentRow)
    return rows
}
