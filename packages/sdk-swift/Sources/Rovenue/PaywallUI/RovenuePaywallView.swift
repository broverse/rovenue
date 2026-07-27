//
//  RovenuePaywallView.swift
//  Native SwiftUI renderer for Phase-B builder paywalls — draws the same
//  7-node component tree the web renderer (packages/paywall-renderer) draws,
//  with variables fed by real StoreKit pricing. Semantics mirror the web
//  renderer (the normative sibling): unknown node → fallback else nothing,
//  never a crash; empty packageIds = every offering package; restore hidden
//  without a handler; the renderer NEVER opens URLs itself.
//

import SwiftUI

public struct RovenuePaywallView: View {
    private let paywall: Paywall
    private let locale: String?
    private let colorSchemeOverride: ColorScheme?
    private let onPurchaseCompleted: ((PurchaseResult) -> Void)?
    private let onPurchaseFailed: ((Error) -> Void)?
    private let onClose: (() -> Void)?
    private let onRestore: (() -> Void)?
    private let onUrl: ((URL) -> Void)?
    private let config: BuilderConfigModel?

    @Environment(\.colorScheme) private var environmentScheme
    @State private var selectedPackageId: String?
    @State private var isPurchasing = false
    @State private var didLogShow = false

    public init(
        paywall: Paywall,
        locale: String? = nil,
        colorSchemeOverride: ColorScheme? = nil,
        onPurchaseCompleted: ((PurchaseResult) -> Void)? = nil,
        onPurchaseFailed: ((Error) -> Void)? = nil,
        onClose: (() -> Void)? = nil,
        onRestore: (() -> Void)? = nil,
        onUrl: ((URL) -> Void)? = nil
    ) {
        self.paywall = paywall
        self.locale = locale
        self.colorSchemeOverride = colorSchemeOverride
        self.onPurchaseCompleted = onPurchaseCompleted
        self.onPurchaseFailed = onPurchaseFailed
        self.onClose = onClose
        self.onRestore = onRestore
        self.onUrl = onUrl
        let decoded = paywall.builderConfigJson.flatMap(decodeBuilderConfig)
        self.config = decoded
        _selectedPackageId = State(
            initialValue: decoded.flatMap { initialSelection($0.root, offering: paywall.offering) }
        )
    }

    public var body: some View {
        if let config {
            content(config)
                .onAppear {
                    // Builder paywalls auto-track (Adapty parity); exactly
                    // once per presentation.
                    guard !didLogShow else { return }
                    didLogShow = true
                    Rovenue.shared.logPaywallShown(paywall)
                }
                // @State survives re-inits at the same view identity, so a
                // host swapping in a DIFFERENT paywall without .id() would
                // otherwise keep the previous offering's selection and skip
                // the new paywall's impression log (the Kotlin sibling's
                // bind() resets the same way).
                .onChange(of: paywallStateKey) { _ in
                    selectedPackageId = self.config.flatMap {
                        initialSelection($0.root, offering: paywall.offering)
                    }
                    didLogShow = false
                    isPurchasing = false
                    Rovenue.shared.logPaywallShown(paywall)
                    didLogShow = true
                }
        }
        // No/undecodable builderConfig → nothing. A shipped app must never
        // crash or show garbage because a paywall config regressed.
    }

    @ViewBuilder
    private func content(_ config: BuilderConfigModel) -> some View {
        let dark = (colorSchemeOverride ?? environmentScheme) == .dark
        let ctx = PaywallRenderContext(
            config: config,
            locale: locale,
            dark: dark,
            offering: paywall.offering,
            selectedPackageId: selectedPackageId,
            isPurchasing: isPurchasing,
            select: { selectedPackageId = $0 },
            purchase: startPurchase,
            onClose: {
                Rovenue.shared.logPaywallClosed(paywall)
                onClose?()
            },
            onRestore: onRestore,
            onUrl: onUrl,
            appVersion: configuredAppVersionOrNil
        )
        GeometryReader { proxy in
            ZStack {
                if let bg = config.background,
                   let rgba = parseHexColor(themeValue(bg, dark: dark)) {
                    color(rgba).ignoresSafeArea()
                }
                ScrollView {
                    // minHeight rather than height, with top alignment, is
                    // what keeps a short paywall filling the screen — without
                    // it the ScrollView's content stops filling available
                    // height, so a flexible Spacer collapses and any stack
                    // pushing its CTA to the bottom rides up instead.
                    BuilderNodeView(node: config.root, ctx: ctx, cell: nil)
                        .frame(minHeight: proxy.size.height, alignment: .top)
                }
            }
        }
    }

    /// Identity of "which paywall is this view showing" for the swap-reset
    /// onChange: identifier + config content (covers same-config paywalls
    /// with different offerings and config edits on the same paywall).
    private var paywallStateKey: String {
        (paywall.paywallIdentifier ?? "") + "|" + (paywall.builderConfigJson ?? "")
    }

    /// The app version supplied to `Rovenue.configure`, feeding the
    /// `visibility.minAppVersion`/`maxAppVersion` gate in
    /// `BuilderNodeView`. `nil` when a paywall renders before
    /// `configure()` ever ran — `Rovenue.shared` traps in that case, so
    /// this reads the non-trapping `sharedIfConfigured` peek instead and
    /// fails open (see `BuilderNodeView.body`), never crashes. Platform
    /// itself is NOT threaded through the context — it's the compile-time
    /// literal `BuilderNodeView` gates on directly.
    private var configuredAppVersionOrNil: String? {
        Rovenue.sharedIfConfigured?.configuredAppVersion
    }

    private func startPurchase() {
        guard !isPurchasing,
              let id = selectedPackageId,
              let pkg = paywall.offering?.packages.first(where: { $0.identifier == id })
        else { return }
        isPurchasing = true
        Task { @MainActor in
            do {
                let result = try await Rovenue.shared.purchase(pkg)
                onPurchaseCompleted?(result)
            } catch {
                onPurchaseFailed?(error)
            }
            isPurchasing = false
        }
    }
}

// MARK: - Render context

struct PaywallRenderContext {
    let config: BuilderConfigModel
    let locale: String?
    let dark: Bool
    let offering: Offering?
    let selectedPackageId: String?
    let isPurchasing: Bool
    let select: (String) -> Void
    let purchase: () -> Void
    let onClose: (() -> Void)?
    let onRestore: (() -> Void)?
    let onUrl: ((URL) -> Void)?
    /// The host app's version, as resolved by `Rovenue.configure`/`shared`
    /// at bind time — feeds the `visibility.minAppVersion`/
    /// `maxAppVersion` gate in `BuilderNodeView.body`. `nil` when a
    /// paywall renders before an appVersion was ever configured; the gate
    /// fails open in that case (see Visibility.swift), never crashes.
    let appVersion: String?

    /// Localized + variable-resolved label. `cell` scopes variables to a
    /// package cell; elsewhere the selected package wins.
    func label(_ key: String, cell: CellScope?) -> String {
        let text = resolveText(config, locale: locale, key: key) ?? ""
        let pkg = relevantPackageView(
            cell: cell?.view, selectedPackageId: selectedPackageId, offering: offering)
        return resolveVariables(text, pkg: pkg)
    }
}

/// The package a `cellTemplate` subtree is currently scoped to — carries
/// both the identifier (needed to evaluate the `selected` override
/// condition against the live global selection) and its resolved
/// `PackageView` (needed for `{{variable}}` substitution). `nil` outside any
/// `cellTemplate` subtree. Mirrors nodes.tsx's `insideCellTemplate` +
/// `cellPackageId` pair, bundled into one value since they always travel
/// together.
struct CellScope {
    let packageId: String
    let view: PackageView
}

// MARK: - Node views

/// This SDK's compile-time platform literal for the `visibility` gate —
/// never "web", the other value the shared `VisibilityPlatform` union
/// allows (see BuilderConfigModel.swift's `Visibility` doc). NOT threaded
/// through `PaywallRenderContext` — every renderer gates on its own
/// compile-time literal directly (mirrors the Kotlin/RN siblings).
private let paywallVisibilityPlatform = "ios"

/// Defaults mirroring packages/shared/src/paywall/schema.ts's
/// `DIVIDER_DEFAULT_THICKNESS` / `DIVIDER_DEFAULT_INSET` / `ICON_DEFAULT_SIZE` /
/// `DIVIDER_DEFAULT_COLOR` — device-independent pixels, hex colors. Keep
/// `dividerDefaultColor` in sync with schema.ts's constant by hand; there is
/// no codegen step sharing it across platforms. NOT `private` (module-
/// internal instead): `PaywallRenderSupportTests` compares these against
/// `render-fixtures.json`'s generated `defaults` object by value (see
/// schema.ts's `_comment` / the `defaults` key), which is only possible if
/// the test target can see them through `@testable import Rovenue`.
let dividerDefaultThickness = 1.0
let dividerDefaultInset = 0.0
private let iconDefaultSize = 24.0
let dividerDefaultColor = ThemePair(light: "#E5E7EB", dark: "#374151")

/// Defaults mirroring packages/shared/src/paywall/schema.ts's
/// `FEATURE_ROW_DEFAULT_ICON` / `FEATURE_ROW_EXCLUDED_ICON` /
/// `FEATURE_ROW_DEFAULT_INCLUDED` / `TIMELINE_ROW_DEFAULT_ICON` /
/// `TIMELINE_CONNECTOR_DEFAULT_COLOR` (same hex as `dividerDefaultColor` —
/// the connector is the same hairline as a divider) /
/// `SOCIAL_PROOF_STAR_DEFAULT_COLOR` / `SOCIAL_PROOF_MAX_RATING`. Keep in
/// sync with schema.ts by hand; there is no codegen step sharing these
/// across platforms. NOT `private` for the same reason as the divider
/// defaults above — see that doc comment.
let featureRowDefaultIcon = "check"
let featureRowExcludedIcon = "x"
let featureRowDefaultIncluded = true
let timelineRowDefaultIcon = "clock"
let timelineConnectorDefaultColor = dividerDefaultColor
let socialProofStarDefaultColor = ThemePair(light: "#F59E0B", dark: "#FBBF24")
let socialProofMaxRating = 5

/// Layout spacing constants for the three row-carrying node types, in
/// points — named rather than inlined (mirrors NodeViewFactory.kt's
/// FEATURE_LIST_ROW_SPACING_DP/TIMELINE_MARK_GAP_DP/etc; no cross-platform
/// pixel-parity contract exists across these, same caveat as the Kotlin
/// constants' doc comment).
private let featureListRowSpacing: CGFloat = 8
private let featureRowIconGap: CGFloat = 8
private let timelineMarkGap: CGFloat = 12
private let timelineMarkColumnSpacing: CGFloat = 4
private let timelineConnectorWidth: CGFloat = 2
private let timelineTextColumnSpacing: CGFloat = 2
private let socialProofRowGap: CGFloat = 4
private let socialProofStarGap: CGFloat = 2

/// A feature row's mark: its own `icon` if given, otherwise the excluded
/// mark when `included` resolves to `false`, else the included default.
/// Exposed (not `private`) so tests can assert WHICH symbol an excluded row
/// resolves to via `sfSymbolName(for:)` — asserting merely that *some*
/// symbol rendered would pass even with the wrong branch, since both
/// `check` and `x` are real, drawable SF Symbols. Mirrors nodes.tsx's
/// `renderFeatureList` row-icon resolution.
func resolvedFeatureRowIconName(_ row: FeatureRowProps) -> String {
    let included = row.included ?? featureRowDefaultIncluded
    return row.icon ?? (included ? featureRowDefaultIcon : featureRowExcludedIcon)
}

/// Whether the star at `index` (0-based) is filled for `rating`: the first
/// `floor(rating)` stars, so a 4.5 rating fills indices 0-3 (4 stars), not
/// 0-4. Exposed (not `private`), and extracted out of `SocialProofView`'s
/// body, for the same reason as `resolvedFeatureRowIconName` above — a
/// SwiftUI view's body isn't inspectable without a view-testing dependency
/// this package doesn't carry, so the fractional-rating rule needs a pure,
/// directly-testable entry point. Mirrors nodes.tsx's `renderSocialProof`
/// (`Math.floor`) and NodeViewFactory.kt's `socialProofStarFilled`.
func socialProofStarFilled(index: Int, rating: Double) -> Bool {
    Double(index) < rating.rounded(.down)
}

struct BuilderNodeView: View {
    let node: BuilderNode
    let ctx: PaywallRenderContext
    let cell: CellScope?

    /// The gate's decision for this node, split out of `body` so it is
    /// reachable from tests: SwiftUI's `body` cannot be inspected without a
    /// view-testing dependency this package does not carry, so asserting on
    /// `body` directly is not possible here. Testing THIS instead pins the
    /// wiring that can realistically drift — that the platform literal is
    /// the SDK's own, that the app version comes from the render context,
    /// and that the RAW `node.visibility` is read rather than the
    /// overrides-applied node. What it cannot pin is `body` continuing to
    /// branch on it; see PaywallRenderSupportTests.
    var isVisible: Bool {
        isNodeVisible(node.visibility, platform: paywallVisibilityPlatform, appVersion: ctx.appVersion)
    }

    var body: some View {
        // Visibility is gated FIRST, on the RAW `node.visibility` — before
        // overrides are resolved, and before any style/text/child work
        // happens. A hidden node renders NOTHING: not its fallback, not
        // its children. `visibility` is deliberately NOT overridable (see
        // BuilderConfigModel.swift's `Visibility` doc), so it must be read
        // off `node` directly, never off `applyOverrides`'s result.
        if isVisible {
            resolvedContent
        } else {
            EmptyView()
        }
    }

    @ViewBuilder
    private var resolvedContent: some View {
        // Every node passes through `applyOverrides` here, BEFORE any
        // style/text resolution happens in the per-type views below —
        // `resolved` (not the original `node`) is what gets dispatched.
        // Mirrors nodes.tsx's `renderNode`.
        let active = activeOverrideConditions(
            cellPackageId: cell?.packageId, selectedPackageId: ctx.selectedPackageId, offering: ctx.offering)
        let resolved = applyOverrides(node, active: active)
        switch resolved {
        case .stack(let p): StackNodeView(props: p, ctx: ctx, cell: cell)
        case .text(let p): textView(p)
        case .image(let p): imageView(p)
        case .button(let p): ActionButtonView(props: p, ctx: ctx, cell: cell)
        case .packageList(let p): PackageListView(props: p, ctx: ctx)
        case .purchaseButton(let p): PurchaseButtonView(props: p, ctx: ctx)
        case .spacer(let p):
            if let size = p.size {
                Spacer().frame(width: CGFloat(size), height: CGFloat(size))
            } else {
                Spacer()
            }
        case .divider(let p):
            // A hairline rule, not body text: falls back to the shared
            // DIVIDER_DEFAULT_COLOR, not Color.secondary — this used to draw
            // a 30%-opacity secondary bar that read differently from web/
            // Android's opaque defaults for the exact same uncoloured node.
            let overrideColor = p.color.flatMap { parseHexColor(themeValue($0, dark: ctx.dark)) }
            let defaultColor = parseHexColor(themeValue(dividerDefaultColor, dark: ctx.dark))
            Rectangle()
                .fill((overrideColor ?? defaultColor).map { color($0) } ?? Color.secondary)
                .frame(height: CGFloat(p.thickness ?? dividerDefaultThickness))
                .padding(.horizontal, CGFloat(p.inset ?? dividerDefaultInset))
        case .icon(let p):
            if let symbol = sfSymbolName(for: p.name) {
                let side = CGFloat(p.size ?? iconDefaultSize)
                // No default colour here: `nil` lets `.foregroundColor`
                // inherit the ambient (text) colour, same as leaving the
                // modifier off entirely — an icon in a feature row should
                // take the colour of the text beside it. Web/Android mirror
                // this by not emitting a colour / not calling imageTintList.
                Image(systemName: symbol)
                    .resizable()
                    .scaledToFit()
                    .frame(width: side, height: side)
                    .foregroundColor(p.color.flatMap { parseHexColor(themeValue($0, dark: ctx.dark)) }.map { color($0) })
            }
        case .featureList(let p): FeatureListView(props: p, ctx: ctx, cell: cell)
        case .timeline(let p): TimelineView(props: p, ctx: ctx, cell: cell)
        case .socialProof(let p): SocialProofView(props: p, ctx: ctx, cell: cell)
        case .unknown(_, _, let fallback):
            if let fallback {
                BuilderNodeView(node: fallback.node, ctx: ctx, cell: cell)
            }
        }
    }

    @ViewBuilder
    private func textView(_ p: TextProps) -> some View {
        let base = Text(ctx.label(p.key, cell: cell))
            .font(font(for: p.role))
            .multilineTextAlignment(textAlignment(p.align))
        if let pair = p.color, let rgba = parseHexColor(themeValue(pair, dark: ctx.dark)) {
            base.foregroundColor(color(rgba))
        } else {
            base
        }
    }

    @ViewBuilder
    private func imageView(_ p: ImageProps) -> some View {
        let urlString = themeValue(p.url, dark: ctx.dark)
        if let url = URL(string: urlString) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFit()
            } placeholder: {
                Color.clear
            }
            .frame(height: p.height.map { CGFloat($0) })
            .cornerRadius(CGFloat(p.cornerRadius ?? 0))
            .accessibilityLabel(p.alt.map { ctx.label($0, cell: cell) } ?? "")
        }
    }

    private func font(for role: TextRole) -> Font {
        switch role {
        case .title: return .title.weight(.bold)
        case .subtitle: return .title3
        case .body: return .body
        case .caption: return .caption
        }
    }

    private func textAlignment(_ align: HAlign?) -> TextAlignment {
        switch align {
        case .start, .none: return .leading
        case .center: return .center
        case .end: return .trailing
        }
    }
}

struct StackNodeView: View {
    let props: StackProps
    let ctx: PaywallRenderContext
    let cell: CellScope?

    var body: some View {
        styled(stackContent)
    }

    @ViewBuilder
    private var stackContent: some View {
        let spacing = props.spacing.map { CGFloat($0) }
        switch props.axis {
        case .v:
            VStack(alignment: horizontalAlignment, spacing: spacing) { children }
        case .h:
            HStack(alignment: verticalAlignment, spacing: spacing) { children }
        case .z:
            ZStack(alignment: zAlignment) { children }
        }
    }

    private var children: some View {
        // Positional identity, NOT node.id: node ids are user-authored and
        // only validated server-side at write time — a stale/hostile payload
        // with duplicate sibling ids passes the lenient client decode, and
        // duplicate ForEach ids are undefined behavior in SwiftUI. Position
        // is the correct identity for a full-remount renderer.
        ForEach(Array(props.children.enumerated()), id: \.offset) { entry in
            BuilderNodeView(node: entry.element, ctx: ctx, cell: cell)
        }
    }

    @ViewBuilder
    private func styled(_ content: some View) -> some View {
        content
            .padding(edgeInsets)
            .frame(
                maxWidth: props.size?.width == .fill ? .infinity : nil,
                maxHeight: props.size?.height == .fill ? .infinity : nil
            )
            .frame(width: fixedWidth, height: fixedHeight)
            .background(backgroundColor)
            .cornerRadius(CGFloat(props.cornerRadius ?? 0))
    }

    private var edgeInsets: EdgeInsets {
        EdgeInsets(
            top: CGFloat(props.padding?.t ?? 0),
            leading: CGFloat(props.padding?.l ?? 0),
            bottom: CGFloat(props.padding?.b ?? 0),
            trailing: CGFloat(props.padding?.r ?? 0)
        )
    }

    private var fixedWidth: CGFloat? {
        if case .value(let v)? = props.size?.width { return CGFloat(v) }
        return nil
    }

    private var fixedHeight: CGFloat? {
        if case .value(let v)? = props.size?.height { return CGFloat(v) }
        return nil
    }

    private var backgroundColor: Color {
        guard let pair = props.background,
              let rgba = parseHexColor(themeValue(pair, dark: ctx.dark))
        else { return .clear }
        return color(rgba)
    }

    private var horizontalAlignment: HorizontalAlignment {
        switch props.align {
        case .start, .none: return .leading
        case .center: return .center
        case .end: return .trailing
        }
    }

    private var verticalAlignment: VerticalAlignment {
        switch props.align {
        case .start: return .top
        case .center, .none: return .center
        case .end: return .bottom
        }
    }

    private var zAlignment: Alignment {
        switch props.align {
        case .start: return .topLeading
        case .center, .none: return .center
        case .end: return .bottomTrailing
        }
    }
}

struct ActionButtonView: View {
    let props: ButtonProps
    let ctx: PaywallRenderContext
    let cell: CellScope?

    var body: some View {
        if actionButtonVisible(props.action, hasRestoreHandler: ctx.onRestore != nil) {
            Button(action: perform) {
                Text(ctx.label(props.labelKey, cell: cell))
                    .font(props.style == .primary ? .body.weight(.semibold) : .body)
            }
            .buttonStyle(.plain)
            .opacity(props.style == .plain ? 0.7 : 1)
        }
    }

    private func perform() {
        switch props.action {
        case .close: ctx.onClose?()
        case .restore: ctx.onRestore?()
        case .url(let raw):
            // The renderer never navigates itself — hosts decide (and should
            // scheme-check before opening).
            if let url = URL(string: raw) { ctx.onUrl?(url) }
        }
    }
}

struct PackageListView: View {
    let props: PackageListProps
    let ctx: PaywallRenderContext

    var body: some View {
        let ids = effectivePackageIds(props, offering: ctx.offering)
        let cells = ids.compactMap { id in
            ctx.offering?.packages.first(where: { $0.identifier == id })
        }
        Group {
            if props.cellLayout == .row {
                HStack(spacing: 8) { cellViews(cells) }
            } else {
                VStack(spacing: 8) { cellViews(cells) }
            }
        }
    }

    @ViewBuilder
    private func cellViews(_ cells: [Package]) -> some View {
        // Positional identity for the same reason as stack children: the
        // cell list is derived from user-authored packageIds, which the
        // client never re-validates for uniqueness.
        ForEach(Array(cells.enumerated()), id: \.offset) { cellEntry in
            let pkg = cellEntry.element
            let selected = ctx.selectedPackageId == pkg.identifier
            if let template = props.cellTemplate {
                // Render the template subtree once per package, INSIDE the
                // same pressable cell wrapper (selection/click unchanged) —
                // the cell-scoped `CellScope` is what makes `{{price}}` etc.
                // inside the template resolve to THIS cell's package rather
                // than the globally selected one, and what makes a
                // `selected`-condition override inside the template match
                // only the currently-selected cell.
                let view = packageView(from: pkg.product, displayName: pkg.product.displayName, offering: ctx.offering)
                let cell = CellScope(packageId: pkg.identifier, view: view)
                Button {
                    ctx.select(pkg.identifier)
                } label: {
                    BuilderNodeView(node: template.node, ctx: ctx, cell: cell)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            } else {
                // No cellTemplate -> built-in cell (name + price), unchanged
                // from before overrides/cellTemplate existed.
                let view = packageView(from: pkg.product, displayName: pkg.product.displayName, offering: ctx.offering)
                Button {
                    ctx.select(pkg.identifier)
                } label: {
                    VStack(spacing: 2) {
                        Text(view.packageName).font(.body.weight(.semibold))
                        Text(view.pricePerPeriod).font(.caption)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(selected ? Color.accentColor : Color.secondary.opacity(0.35),
                                    lineWidth: selected ? 2 : 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
        }
    }
}

struct PurchaseButtonView: View {
    let props: PurchaseButtonProps
    let ctx: PaywallRenderContext

    var body: some View {
        let enabled = purchaseEnabled(
            selectedPackageId: ctx.selectedPackageId, isPurchasing: ctx.isPurchasing)
        // The GLOBAL selection, not any cellTemplate scope — a purchaseButton
        // is schema-forbidden inside cellTemplate, so `cell: nil` here always
        // resolves the same selected PackageView `ctx.label` itself would use
        // for this node. Mirrors nodes.tsx calling `resolveCtaLabelKey` with
        // the selected package's view.
        let selectedView = relevantPackageView(
            cell: nil, selectedPackageId: ctx.selectedPackageId, offering: ctx.offering)
        let resolvedLabelKey = ctaLabelKey(
            labelKey: props.labelKey, trialLabelKey: props.trialLabelKey, selectedView: selectedView)
        Button(action: ctx.purchase) {
            Text(ctx.label(resolvedLabelKey, cell: nil))
                .font(.body.weight(.semibold))
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .background(Color.accentColor.opacity(enabled ? 1 : 0.4))
                .foregroundColor(.white)
                .cornerRadius(12)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

/// Renders `featureList`: a `VStack` of rows, each the row's resolved SF
/// Symbol beside its resolved label. Mirrors nodes.tsx's `renderFeatureList`.
struct FeatureListView: View {
    let props: FeatureListProps
    let ctx: PaywallRenderContext
    let cell: CellScope?

    var body: some View {
        VStack(alignment: .leading, spacing: featureListRowSpacing) {
            ForEach(Array(props.rows.enumerated()), id: \.offset) { entry in
                row(entry.element)
            }
        }
    }

    @ViewBuilder
    private func row(_ row: FeatureRowProps) -> some View {
        let iconName = resolvedFeatureRowIconName(row)
        HStack(spacing: featureRowIconGap) {
            if let symbol = sfSymbolName(for: iconName) {
                Image(systemName: symbol)
                    .resizable()
                    .scaledToFit()
                    .frame(width: CGFloat(iconDefaultSize), height: CGFloat(iconDefaultSize))
                    // Absent `iconColor` passes `nil` so the mark inherits the
                    // row's own text colour — do not substitute a default
                    // (see the `.icon` node case above; same rule).
                    .foregroundColor(resolvedIconColor)
            }
            Text(ctx.label(row.labelKey, cell: cell))
        }
    }

    private var resolvedIconColor: Color? {
        props.iconColor.flatMap { parseHexColor(themeValue($0, dark: ctx.dark)) }.map { color($0) }
    }
}

/// Renders `timeline`: a `VStack` of rows, each the row's resolved SF Symbol,
/// a `Rectangle` connector below it for every row but the last, the label,
/// and the optional caption. `connectorColor` absent falls back to
/// `timelineConnectorDefaultColor`, never a renderer-invented value — it is a
/// rule, not text, so unlike the row's own mark it is never left to inherit.
/// A row's own mark has no configurable colour at all (`TimelineRowProps`
/// carries none), so it always inherits, same as `FeatureListView`'s icon
/// does when uncoloured. Mirrors nodes.tsx's `renderTimeline`.
struct TimelineView: View {
    let props: TimelineProps
    let ctx: PaywallRenderContext
    let cell: CellScope?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(props.rows.enumerated()), id: \.offset) { entry in
                row(entry.element, isLast: entry.offset == props.rows.count - 1)
            }
        }
    }

    @ViewBuilder
    private func row(_ row: TimelineRowProps, isLast: Bool) -> some View {
        HStack(alignment: .top, spacing: timelineMarkGap) {
            VStack(spacing: timelineMarkColumnSpacing) {
                if let symbol = sfSymbolName(for: row.icon ?? timelineRowDefaultIcon) {
                    Image(systemName: symbol)
                        .resizable()
                        .scaledToFit()
                        .frame(width: CGFloat(iconDefaultSize), height: CGFloat(iconDefaultSize))
                }
                if !isLast {
                    Rectangle()
                        .fill(connectorColor)
                        .frame(width: timelineConnectorWidth)
                }
            }
            VStack(alignment: .leading, spacing: timelineTextColumnSpacing) {
                Text(ctx.label(row.labelKey, cell: cell))
                if let captionKey = row.captionKey {
                    Text(ctx.label(captionKey, cell: cell))
                        .font(.caption)
                }
            }
        }
    }

    private var connectorColor: Color {
        let overrideColor = props.connectorColor.flatMap { parseHexColor(themeValue($0, dark: ctx.dark)) }
        let defaultColor = parseHexColor(themeValue(timelineConnectorDefaultColor, dark: ctx.dark))
        return (overrideColor ?? defaultColor).map { color($0) } ?? Color.secondary
    }
}

/// Renders `socialProof`: `SOCIAL_PROOF_MAX_RATING` stars with the first
/// `floor(rating)` filled, then the label. `rating` absent renders no stars
/// at all — not zero filled ones. `starColor` absent falls back to
/// `socialProofStarDefaultColor`, same pattern as the timeline connector:
/// stars are a rule-like mark, not text, so an absent colour is never left
/// to inherit. Mirrors nodes.tsx's `renderSocialProof`.
struct SocialProofView: View {
    let props: SocialProofProps
    let ctx: PaywallRenderContext
    let cell: CellScope?

    var body: some View {
        VStack(alignment: .leading, spacing: socialProofRowGap) {
            if let rating = props.rating {
                HStack(spacing: socialProofStarGap) {
                    ForEach(0..<socialProofMaxRating, id: \.self) { index in
                        Image(systemName: socialProofStarFilled(index: index, rating: rating) ? "star.fill" : "star")
                            .resizable()
                            .scaledToFit()
                            .frame(width: CGFloat(iconDefaultSize), height: CGFloat(iconDefaultSize))
                            .foregroundColor(starColor)
                    }
                }
            }
            Text(ctx.label(props.labelKey, cell: cell))
        }
    }

    private var starColor: Color {
        let overrideColor = props.starColor.flatMap { parseHexColor(themeValue($0, dark: ctx.dark)) }
        let defaultColor = parseHexColor(themeValue(socialProofStarDefaultColor, dark: ctx.dark))
        return (overrideColor ?? defaultColor).map { color($0) } ?? Color.secondary
    }
}

// MARK: - Color bridging

private func color(_ rgba: RGBAColor) -> Color {
    Color(red: rgba.red, green: rgba.green, blue: rgba.blue, opacity: rgba.alpha)
}
