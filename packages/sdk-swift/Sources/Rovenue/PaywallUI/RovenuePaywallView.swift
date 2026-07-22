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
            onClose: onClose,
            onRestore: onRestore,
            onUrl: onUrl
        )
        ZStack {
            if let bg = config.background,
               let rgba = parseHexColor(themeValue(bg, dark: dark)) {
                color(rgba).ignoresSafeArea()
            }
            BuilderNodeView(node: config.root, ctx: ctx, cellPackage: nil)
        }
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

    /// Localized + variable-resolved label. `cellPackage` scopes variables
    /// to a package cell; elsewhere the selected package wins.
    func label(_ key: String, cellPackage: PackageView?) -> String {
        let text = resolveText(config, locale: locale, key: key) ?? ""
        let pkg = relevantPackageView(
            cell: cellPackage, selectedPackageId: selectedPackageId, offering: offering)
        return resolveVariables(text, pkg: pkg)
    }
}

// MARK: - Node views

struct BuilderNodeView: View {
    let node: BuilderNode
    let ctx: PaywallRenderContext
    let cellPackage: PackageView?

    var body: some View {
        switch node {
        case .stack(let p): StackNodeView(props: p, ctx: ctx, cellPackage: cellPackage)
        case .text(let p): textView(p)
        case .image(let p): imageView(p)
        case .button(let p): ActionButtonView(props: p, ctx: ctx, cellPackage: cellPackage)
        case .packageList(let p): PackageListView(props: p, ctx: ctx)
        case .purchaseButton(let p): PurchaseButtonView(props: p, ctx: ctx)
        case .spacer(let p):
            if let size = p.size {
                Spacer().frame(width: CGFloat(size), height: CGFloat(size))
            } else {
                Spacer()
            }
        case .unknown(_, let fallback):
            if let fallback {
                BuilderNodeView(node: fallback.node, ctx: ctx, cellPackage: cellPackage)
            }
        }
    }

    @ViewBuilder
    private func textView(_ p: TextProps) -> some View {
        let base = Text(ctx.label(p.key, cellPackage: cellPackage))
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
            .accessibilityLabel(p.alt.map { ctx.label($0, cellPackage: cellPackage) } ?? "")
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
    let cellPackage: PackageView?

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
        ForEach(props.children, id: \.id) { child in
            BuilderNodeView(node: child, ctx: ctx, cellPackage: cellPackage)
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
    let cellPackage: PackageView?

    var body: some View {
        if actionButtonVisible(props.action, hasRestoreHandler: ctx.onRestore != nil) {
            Button(action: perform) {
                Text(ctx.label(props.labelKey, cellPackage: cellPackage))
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

    private func cellViews(_ cells: [Package]) -> some View {
        ForEach(cells, id: \.identifier) { pkg in
            let view = packageView(from: pkg.product, displayName: pkg.product.displayName)
            let selected = ctx.selectedPackageId == pkg.identifier
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

struct PurchaseButtonView: View {
    let props: PurchaseButtonProps
    let ctx: PaywallRenderContext

    var body: some View {
        let enabled = purchaseEnabled(
            selectedPackageId: ctx.selectedPackageId, isPurchasing: ctx.isPurchasing)
        Button(action: ctx.purchase) {
            Text(ctx.label(props.labelKey, cellPackage: nil))
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

// MARK: - Color bridging

private func color(_ rgba: RGBAColor) -> Color {
    Color(red: rgba.red, green: rgba.green, blue: rgba.blue, opacity: rgba.alpha)
}
