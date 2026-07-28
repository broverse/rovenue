//
//  RovenuePaywallView.swift
//  Native SwiftUI renderer for Phase-B builder paywalls — draws the same
//  7-node component tree the web renderer (packages/paywall-renderer) draws,
//  with variables fed by real StoreKit pricing. Semantics mirror the web
//  renderer (the normative sibling): unknown node → fallback else nothing,
//  never a crash; empty packageIds = every offering package; restore hidden
//  without a handler; the renderer NEVER opens URLs itself.
//

import Combine
import Foundation
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
    /// The scrolled content's bottom clearance for a pinned `stickyFooter`,
    /// updated to the footer's MEASURED height once it lays out (see
    /// `StickyFooterHeightKey`) — a fixed guess is wrong whenever the footer
    /// is taller than it (a CTA plus fine print routinely is), leaving the
    /// last scrolled item unreachable, the same class of bug as no
    /// scrolling at all, just subtler.
    @State private var footerClearance: CGFloat = stickyFooterContentClearanceDefault

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
            appVersion: configuredAppVersionOrNil,
            paywallIdentifier: paywall.paywallIdentifier
        )
        // Same partition the web renderer performs on `config.root.children`
        // (see renderer.tsx's `partitionRootChildren`): the LAST
        // `stickyFooter` among the root's DIRECT children is pulled out and
        // pinned over the ScrollView; a `stickyFooter` anywhere else is left
        // in place and reaches the ordinary `BuilderNodeView` dispatch, which
        // renders it in-flow (see `StickyFooterView`'s doc comment).
        let partition = partitionRootChildren(config.root)
        let scrolledRoot = scrolledRootNode(config.root, scrolledChildren: partition.scrolledChildren)
        let footerNode: BuilderNode? = partition.stickyFooter.map { .stickyFooter($0) }

        ZStack {
            if let bg = config.background,
               let rgba = parseHexColor(themeValue(bg, dark: dark)) {
                color(rgba).ignoresSafeArea()
            }
            // The GeometryReader wraps the ScrollView DIRECTLY, so
            // `proxy.size` IS the scroll viewport: whatever space this view
            // was given, minus nothing. Measuring an ancestor that also
            // contained the footer (the previous shape) made the minimum
            // taller than the viewport by the footer's height, which pushed
            // a bottom-anchored CTA below the fold — the very bug the
            // viewport fill exists to prevent.
            GeometryReader { proxy in
                ScrollView {
                    // Order is load-bearing, and it is the SwiftUI spelling
                    // of the web renderer's `box-sizing: border-box`:
                    // padding FIRST, then the minimum, so the footer's
                    // clearance is carved OUT of the viewport minimum
                    // instead of being added on top of it. The other order
                    // makes every short footered paywall exactly one
                    // footer's height too tall — scrollable for nothing —
                    // and lays a bottom-anchored CTA out at the bottom of
                    // the viewport, i.e. underneath the footer.
                    //
                    // minHeight rather than height, with top alignment, is
                    // what keeps a short paywall filling the screen — without
                    // it the ScrollView's content stops filling available
                    // height, so a flexible Spacer collapses and any stack
                    // pushing its CTA to the bottom rides up instead.
                    BuilderNodeView(node: scrolledRoot, ctx: ctx, cell: nil)
                        // Reserve clearance for the footer overlaying the
                        // bottom of the scroll area, or the last scrolled
                        // item ends up underneath it and unreachable — the
                        // same class of bug as no scrolling at all, just
                        // subtler. `footerClearance` starts at a
                        // pre-measurement guess and is replaced by the
                        // footer's real height as soon as it lays out (see
                        // `StickyFooterHeightKey` below).
                        .padding(.bottom, footerNode != nil ? footerClearance : 0)
                        .frame(minHeight: proxy.size.height, alignment: .top)
                }
                // The footer OVERLAYS the scroll area rather than standing
                // beside it in a VStack — the layout model the spec is
                // written for ("the scrolled content gets bottom padding
                // equal to the footer's height so the last item is never
                // hidden beneath it") and the one the opaque-background
                // default exists for ("a pinned bar needs an opaque
                // background or the content scrolls visibly beneath it").
                // A sibling stack would shorten the viewport by the footer's
                // height AND then pad the content by it again: the same
                // clearance counted twice.
                //
                // An overlay does not participate in its host's layout, so
                // the ScrollView still gets the whole `proxy.size` above.
                // The footer sits at the bottom of the SAFE AREA (this
                // GeometryReader is inset by it — only the background
                // ignores it), never under the home indicator, and carries
                // no extra outer padding: an outer pad would be a
                // transparent strip with content scrolling visibly through
                // it, since `StickyFooterView` paints its opaque background
                // across its own bounds only.
                .overlay(alignment: .bottom) {
                    if let footerNode {
                        BuilderNodeView(node: footerNode, ctx: ctx, cell: nil)
                            .background(
                                GeometryReader { footerProxy in
                                    Color.clear.preference(
                                        key: StickyFooterHeightKey.self, value: footerProxy.size.height)
                                }
                            )
                    }
                }
            }
        }
        .onPreferenceChange(StickyFooterHeightKey.self) { measured in
            footerClearance = measured
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
    /// This paywall's stable identifier — keys `countdown`'s persisted
    /// first-show anchor (see `countdownFirstShownAt`). `nil` for a
    /// programmatically-built paywall that never carries one; `CountdownView`
    /// falls back to a fixed key in that case (still persisted, just shared
    /// across every identifier-less paywall).
    let paywallIdentifier: String?

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

/// Defaults mirroring packages/shared/src/paywall/schema.ts's
/// `STICKY_FOOTER_DEFAULT_BACKGROUND` / `COUNTDOWN_DEFAULT_ON_EXPIRY` /
/// `COUNTDOWN_TICK_MS`. Keep in sync with schema.ts by hand; there is no
/// codegen step sharing these across platforms — NOT `private`, for the same
/// reason as the divider defaults above: the shared-defaults fixture test
/// compares each of them against render-fixtures.json's `defaults` object BY
/// VALUE, which it cannot do through `private`.
let stickyFooterDefaultBackground = ThemePair(light: "#FFFFFF", dark: "#111827")
let countdownDefaultOnExpiry = CountdownOnExpiry.freeze
/// Milliseconds, matching schema.ts's `COUNTDOWN_TICK_MS` — converted to
/// seconds at the one call site that needs a `TimeInterval` (`CountdownView`)
/// via `countdownMillisecondsPerSecond` (nodes.tsx's `COUNTDOWN_MS_PER_SECOND`).
let countdownTickMs = 1000
private let countdownMillisecondsPerSecond = 1000.0

/// Pre-measurement initial value for the scrolled content's bottom
/// clearance under a pinned `stickyFooter`, used only until the footer's
/// first real layout pass reports its height via `StickyFooterHeightKey` —
/// mirrors renderer.tsx's `STICKY_FOOTER_CONTENT_CLEARANCE_PX`.
let stickyFooterContentClearanceDefault: CGFloat = 96

/// Defaults mirroring packages/shared/src/paywall/schema.ts's
/// `CAROUSEL_DEFAULT_SHOWS_INDICATOR` / `CAROUSEL_DEFAULT_LOOP` /
/// `CAROUSEL_MIN_AUTO_ADVANCE_SECONDS`. Keep in sync with schema.ts by hand;
/// there is no codegen step sharing these across platforms — NOT `private`,
/// for the same reason as the divider defaults above: the shared-defaults
/// fixture test compares each of them against render-fixtures.json's
/// `defaults` object BY VALUE, which it cannot do through `private`.
let carouselDefaultShowsIndicator = true
let carouselDefaultLoop = false
/// Seconds. Authoring-time advice only (schema.ts's own comment: below this,
/// dots move faster than a reader can follow) — `CarouselView` honours
/// whatever `autoAdvanceSeconds` it is given; this is not a clamp.
let carouselMinAutoAdvanceSeconds = 2
/// The index a looping carousel wraps back to, and the page it opens on.
private let carouselFirstPageIndex = 0

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

// MARK: - stickyFooter root partition

/// Result of splitting the root's direct children into "everything the
/// scroller owns" and "the pinned footer" — mirrors renderer.tsx's
/// `partitionRootChildren` return shape.
struct RootPartition {
    let scrolledChildren: [BuilderNode]
    let stickyFooter: StickyFooterProps?
}

/// Split `root`'s direct children into the scrolled content and the pinned
/// footer.
///
/// The rule (shared by all three renderers, stated authoritatively next to
/// the sticky-footer issue codes in packages/shared/src/paywall/validate.ts):
/// a `stickyFooter` is pinned when it is a DIRECT child of the root,
/// WHEREVER it sits among its siblings; among several direct-child footers
/// the LAST one wins and the earlier ones stay in the scrolled content,
/// reaching the ordinary `BuilderNodeView` dispatch which renders them
/// in-flow like a stack (see `StickyFooterView`'s doc comment). Position
/// among siblings deliberately does not matter for a single footer: a pinned
/// bar's position is the bottom of the screen either way, so an author who
/// dropped it above a text node still gets what they meant — reading the
/// rule as "the last child only" silently un-pinned that shape, and the
/// validator, which only warns about non-direct children, said nothing.
///
/// A footer that is not a direct root child at all is left where it is and
/// renders inline; the validator's `STICKY_FOOTER_NOT_AT_ROOT` warning is
/// what tells the author about that. This function does not warn, only
/// partitions. `root` is always a `.stack` here — `decodeBuilderConfig`
/// refuses any other root — but this defensively no-ops for any other case
/// rather than assuming it.
func partitionRootChildren(_ root: BuilderNode) -> RootPartition {
    guard case .stack(let rootProps) = root else {
        return RootPartition(scrolledChildren: [], stickyFooter: nil)
    }
    let children = rootProps.children
    for index in stride(from: children.count - 1, through: 0, by: -1) {
        guard case .stickyFooter(let footer) = children[index] else { continue }
        var scrolled = children
        scrolled.remove(at: index)
        return RootPartition(scrolledChildren: scrolled, stickyFooter: footer)
    }
    return RootPartition(scrolledChildren: children, stickyFooter: nil)
}

/// The same root container (spacing/align/background/etc.), fewer children
/// — the footer itself is rendered and pinned separately (see `content(_:)`
/// in `RovenuePaywallView`). No-ops (returns `root` unchanged) for the
/// defensive non-`.stack` case, matching `partitionRootChildren`.
func scrolledRootNode(_ root: BuilderNode, scrolledChildren: [BuilderNode]) -> BuilderNode {
    guard case .stack(let rootProps) = root else { return root }
    return .stack(StackProps(
        id: rootProps.id, axis: rootProps.axis, children: scrolledChildren,
        spacing: rootProps.spacing, align: rootProps.align, padding: rootProps.padding,
        size: rootProps.size, background: rootProps.background, cornerRadius: rootProps.cornerRadius,
        overrides: rootProps.overrides, visibility: rootProps.visibility, fallback: rootProps.fallback))
}

/// Carries the pinned footer's measured height up to `RovenuePaywallView`'s
/// `.onPreferenceChange` — SwiftUI's equivalent of the web renderer's
/// `ResizeObserver` on the footer element. `reduce` keeps the LATEST value
/// (there is only ever one footer), not a running combination.
struct StickyFooterHeightKey: PreferenceKey {
    /// `let`, not `var`: a mutable static on a `PreferenceKey` is shared
    /// global state nothing ever writes, and it trips Swift 6 strict
    /// concurrency.
    static let defaultValue: CGFloat = stickyFooterContentClearanceDefault
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

// MARK: - countdown

/// `hh:mm:ss`, dropping the hours segment entirely once it's zero — a
/// countdown under an hour shows `mm:ss`, never a leading `00:`. Extracted
/// as a free function (not buried in `CountdownView`'s body) because a
/// SwiftUI view's body isn't inspectable without a view-testing dependency
/// this package doesn't carry — this is the only part of a countdown a unit
/// test here can reach. Mirrors nodes.tsx's `formatCountdown`. A negative
/// `remaining` (there should never be one live, but a stale/replayed value
/// could produce one) clamps to zero rather than producing a negative
/// display.
private let countdownPadWidth = 2

func countdownText(remaining: Int) -> String {
    let totalSeconds = max(remaining, 0)
    let hours = totalSeconds / 3600
    let minutes = (totalSeconds % 3600) / 60
    let seconds = totalSeconds % 60
    func pad(_ n: Int) -> String { String(format: "%0\(countdownPadWidth)d", n) }
    return hours > 0 ? "\(pad(hours)):\(pad(minutes)):\(pad(seconds))" : "\(pad(minutes)):\(pad(seconds))"
}

/// `UserDefaults` key prefix for a countdown's persisted "first shown to
/// this user" instant, one per paywall identifier — every countdown node on
/// the same paywall shares one anchor, since "first show" is a paywall-level
/// concept, not a per-node one. Mirrors schema.ts's
/// `COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX` (and is asserted against it, by
/// value, in the shared-defaults fixture test); the Kotlin SDK's
/// `SharedPreferences` key and the web's `localStorage` key are the same
/// string, so the three agree on where a paywall's anchor lives.
let countdownFirstShownKeyPrefix = "rovenue.paywall.countdown.firstShownAt."

/// The persisted instant a `durationSeconds` countdown anchors its deadline
/// to: on the FIRST call for a given `paywallIdentifier`, stamps and stores
/// `Date()`; every subsequent call for the same identifier reads the stored
/// value back rather than re-stamping it. This is what makes
/// `durationSeconds` an actual deadline rather than a timer that restarts on
/// every open — the web renderer cannot do this itself (no persistence
/// layer of its own; see `PaywallRendererProps.firstShownAt`'s doc comment),
/// but this SDK has `UserDefaults`, so it owns the real thing. `defaults` is
/// injectable for test isolation; production call sites use `.standard`.
func countdownFirstShownAt(paywallIdentifier: String?, defaults: UserDefaults = .standard) -> Date {
    let key = countdownFirstShownKeyPrefix + (paywallIdentifier ?? "")
    if let existing = defaults.object(forKey: key) as? Date {
        return existing
    }
    let now = Date()
    defaults.set(now, forKey: key)
    return now
}

/// `endsAt` is authored as plain `Z`-suffixed UTC (render-fixtures.json's
/// accept entries) but a stray fractional-seconds value is tolerated too —
/// `ISO8601DateFormatter` refuses to parse one against the other's
/// `formatOptions`, so both are tried.
private let countdownIsoFormatter = ISO8601DateFormatter()
private let countdownIsoFormatterWithFractionalSeconds: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

/// The instant a countdown counts down to, or `nil` when it cannot be
/// decided (the caller then shows `fallback`, else nothing — never garbage;
/// the web renderer painting `NaN:NaN` for an unparsable `endsAt` was a
/// finding against it, not a contract to match).
///
/// `endsAt` WINS whenever it is present, including alongside
/// `durationSeconds`: the exclusivity of the two is a TypeScript-only
/// authoring `refine`, so a config carrying both reaches the platform
/// decoders intact (render-fixtures.json carries it as an `acceptLenient`
/// entry precisely to pin this), and "prefer `endsAt`" is the cross-platform
/// contract. An unparsable `endsAt` does NOT fall through to
/// `durationSeconds` — it yields `nil`, matching nodes.tsx's
/// `useCountdownDeadline`.
///
/// Extracted as a free function rather than left as a computed property on
/// `CountdownView` for two reasons: a SwiftUI view's body isn't inspectable
/// without a view-testing dependency this package doesn't carry, so this is
/// the only place a test can reach the preference rule; and it is evaluated
/// ONCE per view construction (see `CountdownView.init`) rather than once
/// per tick, which is what keeps a `durationSeconds` countdown off
/// `UserDefaults` every second.
func countdownDeadline(
    props: CountdownProps, paywallIdentifier: String?, defaults: UserDefaults = .standard
) -> Date? {
    if let endsAt = props.endsAt {
        return countdownIsoFormatter.date(from: endsAt)
            ?? countdownIsoFormatterWithFractionalSeconds.date(from: endsAt)
    }
    if let durationSeconds = props.durationSeconds {
        let anchor = countdownFirstShownAt(paywallIdentifier: paywallIdentifier, defaults: defaults)
        return anchor.addingTimeInterval(durationSeconds)
    }
    return nil
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
        case .stickyFooter(let p): StickyFooterView(props: p, ctx: ctx, cell: cell)
        case .countdown(let p): CountdownView(props: p, ctx: ctx, cell: cell)
        case .carousel(let p): CarouselView(props: p, ctx: ctx, cell: cell)
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

/// Renders `stickyFooter` reached through the ORDINARY `BuilderNodeView`
/// dispatch — always the plain, in-flow shape (background + a `VStack` of
/// children), never pinned. `RovenuePaywallView.content(_:)` is what gives a
/// ROOT-level instance its pinned behaviour: it renders this SAME node
/// through this SAME view (see `footerNode` in `content(_:)`), then wraps
/// the result in a measured, non-scrolling container below the `ScrollView`
/// — the pinning lives entirely in that wrapper, not in this view. A
/// misplaced footer (anywhere but the root's last direct child) therefore
/// renders identically to this, just without the wrapper — deliberate,
/// mirrors nodes.tsx's `renderStickyFooter` doc comment. The validator's
/// `STICKY_FOOTER_NOT_AT_ROOT` warning is what tells the author about that
/// case.
struct StickyFooterView: View {
    let props: StickyFooterProps
    let ctx: PaywallRenderContext
    let cell: CellScope?

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(props.children.enumerated()), id: \.offset) { entry in
                BuilderNodeView(node: entry.element, ctx: ctx, cell: cell)
            }
        }
        .background(backgroundColor)
    }

    /// A pinned bar needs an opaque background or the content scrolls
    /// visibly beneath it — absent `background` falls back to
    /// `stickyFooterDefaultBackground`, never `Color.clear`/inherit, unlike
    /// an ordinary node's colour (see the `.icon`/`.divider` cases above).
    private var backgroundColor: Color {
        let overrideColor = props.background.flatMap { parseHexColor(themeValue($0, dark: ctx.dark)) }
        let defaultColor = parseHexColor(themeValue(stickyFooterDefaultBackground, dark: ctx.dark))
        return (overrideColor ?? defaultColor).map { color($0) } ?? Color.clear
    }
}

/// Renders `countdown`. A real `View` (not a plain struct like its
/// siblings) because it owns state (the ticking clock) that must live and
/// die with THIS node's own position in the tree.
///
/// Ticks via `Timer.publish(every:).autoconnect()` at
/// `countdownTickMs`-derived interval, subscribed manually into an
/// `AnyCancellable` on `.onAppear` and cancelled on `.onDisappear` —
/// letting the timer run past this view's lifetime would keep firing
/// against a dead tree.
///
/// The deadline is resolved once, in `init`, by `countdownDeadline` (see
/// there for the `endsAt`-wins rule and the persisted `durationSeconds`
/// anchor). `nil` — no parsable `endsAt` and no `durationSeconds` — falls
/// back to `fallback` else nothing, mirroring every other node type's
/// unknown/undecidable case; the validator's `COUNTDOWN_NO_DEADLINE` is what
/// flags the authored version of that, this is the defensive fail-open.
struct CountdownView: View {
    let props: CountdownProps
    let ctx: PaywallRenderContext
    let cell: CellScope?
    /// Resolved ONCE, here, rather than per `body` pass: `body` re-runs on
    /// every tick, and a computed deadline would re-read (and, on a cold
    /// key, re-write) `UserDefaults` once a second for the whole life of a
    /// `durationSeconds` countdown. Stored on the view value, so it is
    /// recomputed only when the parent rebuilds this node — the same
    /// once-per-render cadence the Kotlin sibling's anchor supplier has.
    private let deadline: Date?

    init(props: CountdownProps, ctx: PaywallRenderContext, cell: CellScope?) {
        self.props = props
        self.ctx = ctx
        self.cell = cell
        self.deadline = countdownDeadline(props: props, paywallIdentifier: ctx.paywallIdentifier)
    }

    @State private var now = Date()
    @State private var tickCancellable: AnyCancellable?

    var body: some View {
        if let deadline {
            let remainingSeconds = Int(deadline.timeIntervalSince(now).rounded(.up))
            let onExpiry = props.onExpiry ?? countdownDefaultOnExpiry
            if remainingSeconds <= 0 && onExpiry == .hide {
                // Past its deadline AND told to disappear — unlike the
                // "no deadline at all" case below, this renders NOTHING, not
                // `fallback`: the author said "hide once expired", which is
                // not the same as "could not decide what to show".
                EmptyView()
            } else {
                countdownBody(remainingSeconds: max(remainingSeconds, 0))
                    .onAppear(perform: startTicking)
                    .onDisappear(perform: stopTicking)
            }
        } else if let fallback = props.fallback {
            BuilderNodeView(node: fallback.node, ctx: ctx, cell: cell)
        }
    }

    @ViewBuilder
    private func countdownBody(remainingSeconds: Int) -> some View {
        HStack(spacing: 4) {
            if let labelKey = props.labelKey {
                Text(ctx.label(labelKey, cell: cell))
            }
            Text(countdownText(remaining: remainingSeconds))
        }
        // Absent `color` passes `nil` to `.foregroundColor` so the text
        // inherits the ambient ink — never a substituted value (this is
        // ordinary text, unlike the footer's background).
        .foregroundColor(props.color.flatMap { parseHexColor(themeValue($0, dark: ctx.dark)) }.map { color($0) })
    }

    private func startTicking() {
        guard tickCancellable == nil else { return }
        tickCancellable = Timer.publish(
            every: Double(countdownTickMs) / countdownMillisecondsPerSecond, on: .main, in: .common)
            .autoconnect()
            .sink { value in now = value }
    }

    private func stopTicking() {
        tickCancellable?.cancel()
        tickCancellable = nil
    }
}

/// The single page-step rule the carousel's auto-advance obeys, kept a pure
/// free function rather than a method on `CarouselView` precisely so the loop
/// rule is unit-testable without a SwiftUI runtime — a SwiftUI `body` is not
/// inspectable in this package (see the visibility-gate note in
/// PaywallRenderSupportTests). Mirrors NodeViewFactory.kt's
/// `nextCarouselPage` and nodes.tsx's auto-advance effect:
///
/// - exactly one step per call, never a counter that could drift;
/// - `loop: false` on the last page returns `current` UNCHANGED. That equal
///   return IS the stop signal — the caller latches `stoppedAtEnd` on it and
///   tears the timer down, so a non-looping carousel never rewinds;
/// - `loop: true` on the last page wraps to `carouselFirstPageIndex`;
/// - `pageCount <= 0` returns `current` unchanged. Defensive: a carousel with
///   no renderable pages takes the `fallback` branch instead of ever running
///   a timer, so this is unreachable in practice — it exists so the rule
///   cannot index into or divide by nothing.
func nextCarouselPage(current: Int, pageCount: Int, loop: Bool) -> Int {
    guard pageCount > 0 else { return current }
    let next = current + 1
    if next < pageCount { return next }
    return loop ? carouselFirstPageIndex : current
}

/// The pages a `carousel` actually renders: its children that pass their OWN
/// `visibility` gate, in order.
///
/// A page the gate rejects is DROPPED — not rendered as a blank page, and
/// (because every count downstream derives from this list) with no dot of its
/// own either. This is the cross-platform contract settled in the wave-D1
/// trio review: Android already behaved this way and the web renderer was
/// changed to match. The behaviour iOS shipped before — an empty tab plus a
/// phantom dot — is indefensible from the reader's side: they swipe onto an
/// empty screen, and the dots misreport how much content exists. Do not
/// "restore" it.
///
/// When EVERY page is hidden this returns empty, which lands on exactly the
/// same branch as an authored-empty carousel: render `fallback`, else
/// nothing.
///
/// Pure and free-standing for the same reason as `nextCarouselPage`: it is
/// the decision `CarouselView.body` branches on, and the only part of that
/// branch a test without a SwiftUI runtime can reach.
func visibleCarouselPages(_ children: [BuilderNode], appVersion: String?) -> [BuilderNode] {
    children.filter {
        isNodeVisible($0.visibility, platform: paywallVisibilityPlatform, appVersion: appVersion)
    }
}

/// Renders `carousel`. Pages via `TabView` with `.tabViewStyle(.page)` —
/// available since iOS 14, well under this package's iOS 16 floor, and it
/// supplies BOTH the paging gesture and the dot indicator, so
/// `showsIndicator` maps to `indexDisplayMode` rather than hand-drawn dots.
/// `ScrollView.scrollTargetBehavior(.paging)` (iOS 17+) is deliberately not
/// used — this package still ships iOS 16.
///
/// A real `View` (not a plain struct), same reason as `CountdownView`: it
/// owns state — the current page and the running auto-advance
/// subscription — that must live and die with THIS node's own position in
/// the tree.
///
/// Auto-advance reuses `CountdownView`'s exact `.onAppear`/`.onDisappear` +
/// `Timer.publish(...).autoconnect().sink` lifecycle (start on appear,
/// cancel on disappear — nothing outlives the view), plus a `scenePhase`
/// watch this node adds on top so backgrounding the app genuinely pauses it
/// (see the `.onChange(of: scenePhase)` comment). It departs from
/// `CountdownView` in one way: there is no separately-ticked clock to read
/// back and recompute from. Each `Timer.publish(every: autoAdvanceSeconds)`
/// fire directly performs exactly one page step — never a decrementing
/// counter that could drift or double-fire — and `.onChange(of:
/// currentPage)` tears the running subscription down and stands a fresh one
/// up on EVERY page change, whether that change came from this timer's own
/// advance or a real user swipe. That is what makes a manual swipe restart
/// the auto-advance wait rather than race a stale schedule (mirrors
/// nodes.tsx's `Carousel`, whose auto-advance effect depends on
/// `[currentPage]` for the identical reason).
///
/// `loop: false` reaching the last page sets `stoppedAtEnd` AND stops the
/// subscription outright, in the same call — `currentPage` does not change
/// on that step, so `.onChange` never fires to tear the timer down on its
/// own, and a repeating `Timer.publish` left running would keep firing
/// forever. That is the exact wave-C Critical (parked as NEW-3: iOS kept a
/// `Timer` running past expiry while web stopped its interval) — this does
/// not reopen it. `loop: true` instead wraps to page 0 and keeps ticking.
struct CarouselView: View {
    let props: CarouselProps
    let ctx: PaywallRenderContext
    let cell: CellScope?

    @Environment(\.scenePhase) private var scenePhase

    @State private var currentPage = carouselFirstPageIndex
    @State private var stoppedAtEnd = false
    @State private var tickCancellable: AnyCancellable?

    /// The renderable pages — see `visibleCarouselPages`. Internal rather
    /// than `private` for the same reason `BuilderNodeView.isVisible` is: it
    /// is the value `body` branches on and the one part of that branch a
    /// test can reach.
    var pages: [BuilderNode] { visibleCarouselPages(props.children, appVersion: ctx.appVersion) }
    private var pageCount: Int { pages.count }
    private var showsIndicator: Bool { props.showsIndicator ?? carouselDefaultShowsIndicator }
    private var loop: Bool { props.loop ?? carouselDefaultLoop }

    /// Never a substituted value here — the inverse of `StickyFooterView`'s
    /// always-opaque `background`: an absent `indicatorColor` must not even
    /// call `.tint`, since `.tint(nil)` resets to the system default rather
    /// than leaving whatever ambient tint the paywall already has alone.
    ///
    /// Split out of `indicatorColor` at the RGBA stage so a test can pin the
    /// resolved value — which theme half won, and that it is the authored
    /// colour rather than a placeholder — by component. What no unit test in
    /// this package can pin is the step after it: that `.tint(_:)` actually
    /// recolours `PageTabViewStyle`'s dots, which are a `UIPageControl`
    /// underneath. That is device smoke item S7, deliberately left as smoke
    /// rather than covered by a test that would pass either way.
    var indicatorRGBA: RGBAColor? {
        props.indicatorColor.flatMap { parseHexColor(themeValue($0, dark: ctx.dark)) }
    }

    private var indicatorColor: Color? { indicatorRGBA.map { color($0) } }

    var body: some View {
        if pageCount == 0 {
            // No RENDERABLE pages — either authored empty, or every child
            // dropped by its own `visibility` gate (see
            // `visibleCarouselPages`) — cannot render. Mirrors every other
            // node type's contract: fail to `fallback`, never throw.
            if let fallback = props.fallback {
                BuilderNodeView(node: fallback.node, ctx: ctx, cell: cell)
            }
        } else {
            pagedContent
                .onAppear(perform: scheduleTimer)
                .onDisappear(perform: stopTicking)
                .onChange(of: currentPage) { _ in scheduleTimer() }
                .onChange(of: scenePhase) { phase in
                    // Spec §5 rule 1, "off-screen means paused", the
                    // BACKGROUNDING half: a carousel that advanced while the
                    // app was away would change the page the user comes back
                    // to. `.onDisappear` does not cover this — it fires on
                    // view-tree removal, not on the app leaving the front.
                    // Web pauses on `visibilitychange`; Android on a
                    // ProcessLifecycleOwner observer; this is the iOS half.
                    //
                    // Deliberately reacting only to a CHANGE of scenePhase,
                    // never gating the initial `scheduleTimer()` on it: a
                    // host that never publishes a scene phase (a SwiftUI
                    // view hosted from UIKit without one) would otherwise
                    // read a stale non-active value and disable auto-advance
                    // outright. Reacting to changes degrades to today's
                    // behaviour there instead.
                    //
                    // Resuming goes through `scheduleTimer`, so the
                    // `stoppedAtEnd` latch still holds: a non-looping
                    // carousel that already finished does not restart on
                    // foreground.
                    //
                    // The OTHER half of §5 rule 1 — a carousel scrolled out
                    // of view while still mounted — stays open on both
                    // natives (neither has an IntersectionObserver
                    // equivalent) and is deferred to the media-lifecycle
                    // wave. Smoke item S10.
                    if phase == .active { scheduleTimer() } else { stopTicking() }
                }
        }
    }

    @ViewBuilder
    private var pagedContent: some View {
        let tabs = TabView(selection: $currentPage) {
            // `pages`, NOT `props.children`: a page hidden by its own
            // `visibility` gate is dropped outright, so it gets neither a tab
            // nor a dot (the dots are `TabView`'s own, derived from the tab
            // count). See `visibleCarouselPages`.
            ForEach(Array(pages.enumerated()), id: \.offset) { index, child in
                BuilderNodeView(node: child, ctx: ctx, cell: cell)
                    .tag(index)
            }
        }
        // `.page` (`PageTabViewStyle`) is iOS/tvOS/watchOS only — this
        // package's Package.swift also declares a macOS platform (so
        // `swift test` can build+run on a Mac host); macOS keeps the
        // default `TabView` style, which is fine, since macOS never
        // actually renders this paywall UI in production.
        #if os(iOS)
        // Named `styled`, not `pages` — `pages` is now the renderable-page
        // list this view iterates, and shadowing it here is a compile error.
        let styled = tabs.tabViewStyle(.page(indexDisplayMode: showsIndicator ? .automatic : .never))
        #else
        let styled = tabs
        #endif
        if let indicatorColor {
            styled.tint(indicatorColor)
        } else {
            styled
        }
    }

    private func scheduleTimer() {
        tickCancellable?.cancel()
        tickCancellable = nil
        // Absent `autoAdvanceSeconds` means OFF, deliberately not a default
        // interval (mirrors `CarouselProps.autoAdvanceSeconds`'s own doc
        // comment) — and a single/empty page has nothing to advance to.
        guard let seconds = props.autoAdvanceSeconds, seconds > 0, !stoppedAtEnd, pageCount > 1 else { return }
        tickCancellable = Timer.publish(every: seconds, on: .main, in: .common)
            .autoconnect()
            .sink { _ in advance() }
    }

    private func stopTicking() {
        tickCancellable?.cancel()
        tickCancellable = nil
    }

    private func advance() {
        // The rule itself lives in the pure `nextCarouselPage` so it can be
        // tested without a runtime (mirrors Kotlin). An unchanged index is
        // its stop signal — `loop: false` on the last page — and `.onChange`
        // would never fire for it, so the latch and the teardown happen here
        // in the same call rather than waiting on a page change.
        let next = nextCarouselPage(current: currentPage, pageCount: pageCount, loop: loop)
        if next == currentPage {
            stoppedAtEnd = true
            stopTicking()
        } else {
            currentPage = next
        }
    }
}

// MARK: - Color bridging

private func color(_ rgba: RGBAColor) -> Color {
    Color(red: rgba.red, green: rgba.green, blue: rgba.blue, opacity: rgba.alpha)
}
