//
//  PaywallRenderSupportTests.swift
//  Pure render-rule helpers behind RovenuePaywallView.
//

import XCTest
@testable import Rovenue

final class PaywallRenderSupportTests: XCTestCase {
    // MARK: parseHexColor

    func test_parseHexColor_rrggbb() {
        let c = parseHexColor("#3B82F6")
        XCTAssertNotNil(c)
        XCTAssertEqual(c!.red, 0x3B / 255.0, accuracy: 0.0001)
        XCTAssertEqual(c!.green, 0x82 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(c!.blue, 0xF6 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(c!.alpha, 1.0, accuracy: 0.0001)
    }

    func test_parseHexColor_rrggbbaa_and_no_hash() {
        let c = parseHexColor("0B0B0F80")
        XCTAssertNotNil(c)
        XCTAssertEqual(c!.alpha, 0x80 / 255.0, accuracy: 0.0001)
    }

    func test_parseHexColor_invalid_inputs_are_nil() {
        XCTAssertNil(parseHexColor(""))
        XCTAssertNil(parseHexColor("#FFF"))          // shorthand unsupported
        XCTAssertNil(parseHexColor("#GGGGGG"))
        XCTAssertNil(parseHexColor("rgb(1,2,3)"))
    }

    // MARK: themeValue

    func test_themeValue_prefers_dark_only_in_dark_mode_with_dark_present() {
        let pair = ThemePair(light: "#FFFFFF", dark: "#000000")
        XCTAssertEqual(themeValue(pair, dark: true), "#000000")
        XCTAssertEqual(themeValue(pair, dark: false), "#FFFFFF")
        let lightOnly = ThemePair(light: "#FFFFFF", dark: nil)
        XCTAssertEqual(themeValue(lightOnly, dark: true), "#FFFFFF")
    }

    // MARK: purchaseEnabled

    func test_purchaseEnabled_matrix() {
        XCTAssertTrue(purchaseEnabled(selectedPackageId: "$rov_monthly", isPurchasing: false))
        XCTAssertFalse(purchaseEnabled(selectedPackageId: nil, isPurchasing: false))
        XCTAssertFalse(purchaseEnabled(selectedPackageId: "$rov_monthly", isPurchasing: true))
    }

    // MARK: actionButtonVisible

    func test_restore_hidden_without_handler_other_actions_always_visible() {
        XCTAssertFalse(actionButtonVisible(.restore, hasRestoreHandler: false))
        XCTAssertTrue(actionButtonVisible(.restore, hasRestoreHandler: true))
        XCTAssertTrue(actionButtonVisible(.close, hasRestoreHandler: false))
        XCTAssertTrue(actionButtonVisible(.url("https://example.com"), hasRestoreHandler: false))
    }

    // MARK: relevantPackageView

    func test_relevantPackageView_cell_wins_then_selected_then_nil() {
        let cell = PackageView(packageName: "Cell", price: "$1", pricePerPeriod: "$1/month", period: "month")
        XCTAssertEqual(
            relevantPackageView(cell: cell, selectedPackageId: "x", offering: nil)?.packageName,
            "Cell"
        )
        XCTAssertNil(relevantPackageView(cell: nil, selectedPackageId: nil, offering: nil))
        XCTAssertNil(relevantPackageView(cell: nil, selectedPackageId: "missing", offering: nil))
    }

    // MARK: - visibility gate (BuilderNodeView)
    //
    // These construct a REAL `BuilderNodeView` and assert its `isVisible`
    // — the same value `body` branches on. That pins the wiring that can
    // realistically drift: the platform literal being the SDK's own (not a
    // value the test supplies), the app version coming from the render
    // context, and the RAW `node.visibility` being read rather than the
    // overrides-applied node.
    //
    // KNOWN LIMIT, stated rather than implied: they do NOT prove `body`
    // still branches on `isVisible`. Deleting that `if` would leave these
    // green. SwiftUI bodies are not inspectable without a view-testing
    // dependency (ViewInspector / snapshot testing) that this package does
    // not carry, so closing that last gap needs new test infrastructure —
    // a deliberate scope call, not an oversight. The Kotlin sibling asserts
    // on `NodeViewFactory.build(...)` returning null and the RN sibling
    // renders the whole view, because both have a testable entry point at
    // that level; Swift does not.

    private func makeCtx(appVersion: String?) throws -> PaywallRenderContext {
        let json = """
        {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{}},
         "root":{"type":"stack","id":"root","axis":"v","children":[]}}
        """
        let config = try JSONDecoder().decode(BuilderConfigModel.self, from: Data(json.utf8))
        return PaywallRenderContext(
            config: config, locale: "en", dark: false, offering: nil,
            selectedPackageId: nil, isPurchasing: false,
            select: { _ in }, purchase: {},
            onClose: nil, onRestore: nil, onUrl: nil,
            appVersion: appVersion, paywallIdentifier: nil
        )
    }

    private func view(_ node: BuilderNode, appVersion: String? = nil) throws -> BuilderNodeView {
        BuilderNodeView(node: node, ctx: try makeCtx(appVersion: appVersion), cell: nil)
    }

    func test_platformHidden_gateHidesTheNode() throws {
        // This SDK's literal is "ios", so an android-only node is hidden —
        // and the test never says "ios" itself, so a wrong literal fails.
        let node = BuilderNode.text(
            TextProps(id: "t1", key: "k", role: .body, visibility: Visibility(platform: ["android"])))
        XCTAssertFalse(try view(node).isVisible)
    }

    func test_platformMatching_gateShowsTheNode() throws {
        let node = BuilderNode.text(
            TextProps(id: "t1", key: "k", role: .body, visibility: Visibility(platform: ["ios"])))
        XCTAssertTrue(try view(node).isVisible)
    }

    func test_hiddenStack_gateHidesItBeforeAnyChildIsReached() throws {
        let node = BuilderNode.stack(StackProps(
            id: "root", axis: .v,
            children: [
                .text(TextProps(id: "c1", key: "k1", role: .body)),
                .spacer(SpacerProps(id: "c2")),
            ],
            visibility: Visibility(platform: ["android"])
        ))
        // The gate returns before `resolvedContent` ever looks at
        // `children`, so the children's own (absent) visibility never runs.
        XCTAssertFalse(try view(node).isVisible)
    }

    func test_hiddenNodeWithFallback_stillHidden_fallbackNeverRenders() throws {
        let fallback = BuilderNodeBox(node: .text(TextProps(id: "fb", key: "k2", role: .body)))
        let props = TextProps(
            id: "t1", key: "k", role: .body,
            visibility: Visibility(minAppVersion: "99.0.0"), fallback: fallback
        )
        XCTAssertNotNil(props.fallback, "the node does carry a fallback")
        // `fallback` is only reachable from inside `resolvedContent`, which
        // the gate never enters — hidden means neither content nor fallback.
        XCTAssertFalse(try view(.text(props), appVersion: "1.0.0").isVisible)
    }

    func test_versionBound_readsTheAppVersionFromTheRenderContext() throws {
        // Same node, two contexts: the only difference is ctx.appVersion,
        // so this fails if the gate stops reading it.
        let props = TextProps(
            id: "t1", key: "k", role: .body, visibility: Visibility(minAppVersion: "2.0.0"))
        XCTAssertFalse(try view(.text(props), appVersion: "1.9.9").isVisible)
        XCTAssertTrue(try view(.text(props), appVersion: "2.0.0").isVisible)
    }

    func test_noVisibilityRules_gateShowsTheNode() throws {
        let node = BuilderNode.text(TextProps(id: "t1", key: "k", role: .body))
        XCTAssertTrue(try view(node).isVisible)
    }

    // MARK: - socialProofStarFilled (fractional rating)
    //
    // No test anywhere exercised a fractional rating before this fix wave —
    // `Double(index) < rating` (the pre-fix code) filled index 4 too for a
    // 4.5 rating (4 < 4.5), overstating a fractional rating as a full one.

    func test_socialProofStarFilled_fillsOnlyTheFloorOfAFractionalRating() {
        XCTAssertTrue(socialProofStarFilled(index: 0, rating: 4.5))
        XCTAssertTrue(socialProofStarFilled(index: 3, rating: 4.5))
        XCTAssertFalse(socialProofStarFilled(index: 4, rating: 4.5), "4.5 must fill 4 stars, not 5")
    }

    func test_socialProofStarFilled_fillsExactlyUpToAWholeRating() {
        XCTAssertTrue(socialProofStarFilled(index: 3, rating: 4.0))
        XCTAssertFalse(socialProofStarFilled(index: 4, rating: 4.0))
    }

    // MARK: - cross-platform default constants (mutation-checked)
    //
    // Compares this SDK's hand-mirrored defaults against
    // render-fixtures.json's `defaults` object (generated straight off
    // schema.ts's exported constants — see that file's generation note) BY
    // VALUE, not just "both exist". Mutation-checked in the task report:
    // flipping FEATURE_ROW_DEFAULT_ICON in schema.ts without updating this
    // SDK fails this assertion by value.

    func test_nativeDefaultsMatchTheSharedFixtureByValue() throws {
        let fixture = RenderFixtures.load()
        let defaults = try XCTUnwrap(fixture["defaults"] as? [String: Any])

        func themePair(_ key: String) throws -> ThemePair {
            let dict = try XCTUnwrap(defaults[key] as? [String: Any])
            return ThemePair(light: try XCTUnwrap(dict["light"] as? String), dark: dict["dark"] as? String)
        }

        XCTAssertEqual(dividerDefaultThickness, try XCTUnwrap(defaults["DIVIDER_DEFAULT_THICKNESS"] as? Double))
        XCTAssertEqual(dividerDefaultInset, try XCTUnwrap(defaults["DIVIDER_DEFAULT_INSET"] as? Double))
        XCTAssertEqual(dividerDefaultColor, try themePair("DIVIDER_DEFAULT_COLOR"))
        XCTAssertEqual(featureRowDefaultIcon, try XCTUnwrap(defaults["FEATURE_ROW_DEFAULT_ICON"] as? String))
        XCTAssertEqual(featureRowExcludedIcon, try XCTUnwrap(defaults["FEATURE_ROW_EXCLUDED_ICON"] as? String))
        XCTAssertEqual(featureRowDefaultIncluded, try XCTUnwrap(defaults["FEATURE_ROW_DEFAULT_INCLUDED"] as? Bool))
        XCTAssertEqual(timelineRowDefaultIcon, try XCTUnwrap(defaults["TIMELINE_ROW_DEFAULT_ICON"] as? String))
        XCTAssertEqual(timelineConnectorDefaultColor, try themePair("TIMELINE_CONNECTOR_DEFAULT_COLOR"))
        XCTAssertEqual(socialProofStarDefaultColor, try themePair("SOCIAL_PROOF_STAR_DEFAULT_COLOR"))
        XCTAssertEqual(socialProofMaxRating, try XCTUnwrap(defaults["SOCIAL_PROOF_MAX_RATING"] as? Int))
        XCTAssertEqual(
            countdownDefaultOnExpiry.rawValue,
            try XCTUnwrap(defaults["COUNTDOWN_DEFAULT_ON_EXPIRY"] as? String))
        XCTAssertEqual(countdownTickMs, try XCTUnwrap(defaults["COUNTDOWN_TICK_MS"] as? Int))
        XCTAssertEqual(
            countdownFirstShownKeyPrefix,
            try XCTUnwrap(defaults["COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX"] as? String),
            "the persisted anchor key must be byte-identical across web/iOS/Android")
        XCTAssertEqual(stickyFooterDefaultBackground, try themePair("STICKY_FOOTER_DEFAULT_BACKGROUND"))
        XCTAssertEqual(
            Double(stickyFooterContentClearanceDefault),
            try XCTUnwrap(defaults["STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT"] as? Double))
        XCTAssertEqual(
            carouselDefaultShowsIndicator, try XCTUnwrap(defaults["CAROUSEL_DEFAULT_SHOWS_INDICATOR"] as? Bool))
        XCTAssertEqual(carouselDefaultLoop, try XCTUnwrap(defaults["CAROUSEL_DEFAULT_LOOP"] as? Bool))
        XCTAssertEqual(
            Double(carouselMinAutoAdvanceSeconds),
            try XCTUnwrap(defaults["CAROUSEL_MIN_AUTO_ADVANCE_SECONDS"] as? Double))
    }

    // MARK: - scroll container + pinned-footer layout (wave C)
    //
    // A SwiftUI view's body is not inspectable without a view-testing
    // dependency this package does not carry — but the COMPOSED GENERIC TYPE
    // of `body` is, and it spells the layout out: which container wraps
    // which, and in what order the modifiers were applied. That is enough to
    // pin the three structural decisions this wave's layout rests on, and
    // each of them fails this test if reverted (mutation-checked in the fix
    // report).
    //
    // What it CANNOT see is a numeric value: `.frame(minHeight:)` applied
    // with the wrong height (`proxy.size.height - somethingElse`) produces
    // the identical type. So the value half of Critical 3 stays a device
    // smoke item — see the fix report's smoke feed.

    /// The composed type of `RovenuePaywallView.body` for a minimal config.
    private func bodyTypeDescription(json: String) -> String {
        let paywall = Paywall(
            placementIdentifier: "plc_1",
            placementRevision: 1,
            paywallIdentifier: "pw_1",
            paywallName: "Test",
            configFormatVersion: 2,
            remoteConfig: nil,
            remoteConfigLocale: nil,
            builderConfigJson: json,
            offering: nil,
            presentedContext: nil
        )
        return String(describing: type(of: RovenuePaywallView(paywall: paywall).body))
    }

    private static let minimalPaywallJson = """
    {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{"k":"x"}},
     "root":{"type":"stack","id":"root","axis":"v","children":[{"type":"text","id":"t1","key":"k","role":"body"}]}}
    """

    func test_body_composesAScrollViewAroundTheRootContent() throws {
        let description = bodyTypeDescription(json: Self.minimalPaywallJson)
        XCTAssertTrue(
            description.contains("ScrollView"),
            "expected the paywall root's body to compose a ScrollView, got: \(description)"
        )
    }

    /// Critical 3: the viewport minimum must be measured against the SCROLL
    /// VIEWPORT, so the `GeometryReader` has to wrap the `ScrollView`
    /// directly. Reading an ancestor that also contained the footer made the
    /// minimum taller than the viewport by the footer's height.
    func test_body_measuresTheScrollViewportItselfForTheViewportMinimum() throws {
        let description = bodyTypeDescription(json: Self.minimalPaywallJson)
        XCTAssertTrue(
            description.contains("GeometryReader<ModifiedContent<ScrollView<"),
            "expected the GeometryReader to wrap the ScrollView directly (its size IS the viewport), got: \(description)"
        )
        XCTAssertTrue(
            description.contains("_FlexFrameLayout"),
            "expected the scrolled content to carry a .frame(minHeight:) viewport fill, got: \(description)"
        )
    }

    /// Critical 1, first half: the footer clearance has to be carved OUT of
    /// the viewport minimum, not added on top of it — the SwiftUI spelling
    /// of the web renderer's `box-sizing: border-box`. That is purely a
    /// modifier-ORDER property: `.padding` inside, `.frame(minHeight:)`
    /// outside. Swapping the two makes every short footered paywall exactly
    /// one footer's height too tall, and lays a bottom-anchored CTA out
    /// underneath the footer.
    func test_body_appliesTheFooterClearanceInsideTheViewportMinimum() throws {
        let description = bodyTypeDescription(json: Self.minimalPaywallJson)
        XCTAssertTrue(
            description.contains("ModifiedContent<ModifiedContent<BuilderNodeView, _PaddingLayout>, _FlexFrameLayout>"),
            "expected .padding(.bottom:) to be applied INSIDE .frame(minHeight:), got: \(description)"
        )
    }

    /// Critical 1, second half: the footer OVERLAYS the scroll area. As a
    /// sibling in a `VStack` it would shorten the viewport by its own height
    /// and then have the content padded by that height again — the same
    /// clearance counted twice.
    func test_body_overlaysThePinnedFooterOnTheScrollAreaRatherThanStackingBesideIt() throws {
        let description = bodyTypeDescription(json: Self.minimalPaywallJson)
        XCTAssertTrue(
            description.contains("_OverlayModifier"),
            "expected the pinned footer to be an overlay on the ScrollView, got: \(description)"
        )
        XCTAssertFalse(
            description.contains("VStack"),
            "expected NO VStack: a footer stacked beside the scroller double-counts its clearance, got: \(description)"
        )
    }

    // MARK: - partitionRootChildren / scrolledRootNode (wave C)
    //
    // The pinning rule, shared by all three renderers: a `stickyFooter` is
    // pinned when it is a DIRECT child of the root, wherever it sits among
    // its siblings; among several, the LAST wins and the earlier ones stay
    // in the scrolled content and render inline.

    private func stickyFooter(_ id: String) -> BuilderNode {
        .stickyFooter(StickyFooterProps(id: id, children: []))
    }

    private func text(_ id: String) -> BuilderNode {
        .text(TextProps(id: id, key: "k", role: .body))
    }

    private func root(_ children: [BuilderNode]) -> BuilderNode {
        .stack(StackProps(id: "root", axis: .v, children: children))
    }

    private func nodeIds(_ nodes: [BuilderNode]) -> [String] {
        nodes.map { node in
            switch node {
            case .text(let p): return p.id
            case .stickyFooter(let p): return p.id
            case .stack(let p): return p.id
            default: return "?"
            }
        }
    }

    func test_partition_pinsAFooterThatIsTheLastDirectChild() {
        let partition = partitionRootChildren(root([text("t1"), stickyFooter("sf")]))
        XCTAssertEqual(partition.stickyFooter?.id, "sf")
        XCTAssertEqual(nodeIds(partition.scrolledChildren), ["t1"])
    }

    /// The finding this fix wave closed: a single, correctly-placed footer
    /// that is not the LAST child used to be silently left inline.
    func test_partition_pinsADirectChildFooterThatIsNotLast() {
        let partition = partitionRootChildren(root([stickyFooter("sf"), text("t1"), text("t2")]))
        XCTAssertEqual(partition.stickyFooter?.id, "sf")
        XCTAssertEqual(
            nodeIds(partition.scrolledChildren), ["t1", "t2"],
            "the footer must be removed BY INDEX, leaving its siblings in order")
    }

    func test_partition_lastOfSeveralDirectFootersWinsAndTheEarlierOnesStayInline() {
        let partition = partitionRootChildren(root([stickyFooter("sfA"), text("t1"), stickyFooter("sfB"), text("t2")]))
        XCTAssertEqual(partition.stickyFooter?.id, "sfB", "the LAST direct-child footer is the pinned one")
        XCTAssertEqual(
            nodeIds(partition.scrolledChildren), ["sfA", "t1", "t2"],
            "the earlier footer stays in the scrolled content and renders inline")
    }

    func test_partition_leavesANestedFooterInPlace() {
        let nested = BuilderNode.stack(StackProps(id: "inner", axis: .v, children: [stickyFooter("sf")]))
        let partition = partitionRootChildren(root([text("t1"), nested]))
        XCTAssertNil(partition.stickyFooter, "a footer that is not a DIRECT root child is never pinned")
        XCTAssertEqual(nodeIds(partition.scrolledChildren), ["t1", "inner"])
    }

    func test_partition_noFooterLeavesEveryChildScrolled() {
        let partition = partitionRootChildren(root([text("t1"), text("t2")]))
        XCTAssertNil(partition.stickyFooter)
        XCTAssertEqual(nodeIds(partition.scrolledChildren), ["t1", "t2"])
    }

    func test_partition_defensivelyNoOpsForANonStackRoot() {
        let partition = partitionRootChildren(text("t1"))
        XCTAssertNil(partition.stickyFooter)
        XCTAssertTrue(partition.scrolledChildren.isEmpty)
    }

    func test_scrolledRootNode_keepsTheRootContainerAndSwapsOnlyItsChildren() {
        let original = BuilderNode.stack(StackProps(
            id: "root", axis: .v, children: [text("t1"), stickyFooter("sf")],
            spacing: 12, align: .center, background: ThemePair(light: "#FFFFFF", dark: "#000000"),
            cornerRadius: 8))
        let partition = partitionRootChildren(original)
        guard case .stack(let scrolled) = scrolledRootNode(original, scrolledChildren: partition.scrolledChildren)
        else { return XCTFail("scrolledRootNode must return a .stack for a .stack root") }
        XCTAssertEqual(scrolled.id, "root")
        XCTAssertEqual(scrolled.axis, .v)
        XCTAssertEqual(scrolled.spacing, 12)
        XCTAssertEqual(scrolled.align, .center)
        XCTAssertEqual(scrolled.background?.light, "#FFFFFF")
        XCTAssertEqual(scrolled.cornerRadius, 8)
        XCTAssertEqual(nodeIds(scrolled.children), ["t1"], "the pinned footer is gone from the scrolled tree")
    }

    func test_scrolledRootNode_returnsANonStackRootUnchanged() {
        guard case .text(let unchanged) = scrolledRootNode(text("t1"), scrolledChildren: []) else {
            return XCTFail("a non-.stack root must come back unchanged")
        }
        XCTAssertEqual(unchanged.id, "t1")
    }
}
