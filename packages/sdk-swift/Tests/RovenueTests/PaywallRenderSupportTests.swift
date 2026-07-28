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

    /// `onRestore`, `offering` and `selectedPackageId` are defaulted to the
    /// empty shape every older test here relies on, and are settable because
    /// the carousel's drop rule reads all three: a restore button with no
    /// handler draws nothing, and the two package fields are what decide
    /// whether a node's overrides are active.
    private func makeCtx(
        appVersion: String?, dark: Bool = false, onRestore: (() -> Void)? = nil,
        offering: Offering? = nil, selectedPackageId: String? = nil
    ) throws -> PaywallRenderContext {
        let json = """
        {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{}},
         "root":{"type":"stack","id":"root","axis":"v","children":[]}}
        """
        let config = try JSONDecoder().decode(BuilderConfigModel.self, from: Data(json.utf8))
        return PaywallRenderContext(
            config: config, locale: "en", dark: dark, offering: offering,
            selectedPackageId: selectedPackageId, isPurchasing: false,
            select: { _ in }, purchase: {},
            onClose: nil, onRestore: onRestore, onUrl: nil,
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
        // Nothing but MODIFIERS may sit between the GeometryReader and the
        // ScrollView. Previously spelled as a literal
        // `GeometryReader<ModifiedContent<ScrollView<` substring, which the
        // wave-D2 visibility wiring broke without breaking the invariant — the
        // ScrollView now also carries `.coordinateSpace` and `.environment`,
        // so it is two `ModifiedContent` layers deeper. What the assertion is
        // FOR is unchanged and still fails on the real regression: an
        // intervening LAYOUT container (a VStack, a second GeometryReader,
        // anything that also contained the footer) would make the measured
        // size something other than the scroll viewport.
        let insideGeometryReader = description
            .components(separatedBy: "GeometryReader<").dropFirst().first ?? ""
        let betweenGeometryReaderAndScrollView = insideGeometryReader
            .components(separatedBy: "ScrollView<").first ?? insideGeometryReader
        XCTAssertTrue(description.contains("GeometryReader<"), "no GeometryReader at all: \(description)")
        XCTAssertEqual(
            betweenGeometryReaderAndScrollView.replacingOccurrences(of: "ModifiedContent<", with: ""),
            "",
            "expected only modifiers between the GeometryReader and the ScrollView "
                + "(its size IS the viewport), got: \(description)"
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

    // MARK: - nextCarouselPage (wave D1 page-step rule)
    //
    // The loop rule is the single most important behaviour wave D1 adds, and
    // the one three renderers will otherwise fill three different ways. It
    // was unit-tested on web and on Android (`nextCarouselPage` in
    // NodeViewFactoryTest.kt) and untested here until this fix; the rule now
    // lives in a pure free function on this side too, so these exercise the
    // SAME function `CarouselView.advance()` calls, not a restatement of it.

    func test_nextCarouselPage_advancesOneStepInsideTheRange() {
        XCTAssertEqual(nextCarouselPage(current: 0, pageCount: 3, loop: false), 1)
        XCTAssertEqual(nextCarouselPage(current: 1, pageCount: 3, loop: true), 2)
    }

    /// The stop signal: an UNCHANGED index. `CarouselView.advance()` latches
    /// `stoppedAtEnd` and cancels the subscription on exactly this, so a
    /// non-looping carousel stops for good instead of rewinding.
    func test_nextCarouselPage_staysOnTheLastPageWhenLoopIsFalse() {
        XCTAssertEqual(nextCarouselPage(current: 2, pageCount: 3, loop: false), 2)
    }

    func test_nextCarouselPage_wrapsToTheFirstPageWhenLoopIsTrue() {
        XCTAssertEqual(nextCarouselPage(current: 2, pageCount: 3, loop: true), 0)
    }

    /// Degenerate inputs must not crash, index past the end, or divide by
    /// nothing. A single page has nowhere to go under either loop setting
    /// (the scheduler's own `pageCount > 1` guard means it never even ticks),
    /// and a zero-page carousel returns the index it was handed.
    func test_nextCarouselPage_degenerateInputsStayPut() {
        XCTAssertEqual(nextCarouselPage(current: 0, pageCount: 1, loop: false), 0)
        XCTAssertEqual(nextCarouselPage(current: 0, pageCount: 1, loop: true), 0)
        XCTAssertEqual(nextCarouselPage(current: 0, pageCount: 0, loop: true), 0)
        XCTAssertEqual(nextCarouselPage(current: 4, pageCount: 0, loop: false), 4)
    }

    // MARK: - carousel pages: a page that draws nothing is dropped (C3)
    //
    // The cross-platform contract settled in the wave-D1 trio review: a page
    // that renders nothing is dropped, so it gets neither a blank page nor a
    // dot, and a carousel left with no pages collapses to the `fallback`
    // branch. "Renders nothing" is the BROAD rule Android already had — being
    // hidden by `visibility` is only one of its cases. These read
    // `CarouselView.pages` off a REAL view, which is the value `body`
    // iterates and counts.
    //
    // KNOWN LIMIT, stated rather than implied — the same one the visibility
    // gate above carries: they do not prove `body` still iterates `pages`
    // rather than `props.children`. A SwiftUI `body` is not inspectable
    // without a view-testing dependency this package does not carry. What
    // they do pin is the drop rule itself and the empty/`fallback` branch
    // condition.

    private func carouselPage(_ id: String, visibility: Visibility? = nil) -> BuilderNode {
        .text(TextProps(id: id, key: "k", role: .body, visibility: visibility))
    }

    private func carousel(
        _ children: [BuilderNode], indicatorColor: ThemePair? = nil,
        appVersion: String? = nil, dark: Bool = false
    ) throws -> CarouselView {
        CarouselView(
            props: CarouselProps(id: "c1", children: children, indicatorColor: indicatorColor),
            ctx: try makeCtx(appVersion: appVersion, dark: dark), cell: nil)
    }

    func test_carousel_dropsAPageHiddenByPlatform() throws {
        let view = try carousel([
            carouselPage("p1"),
            carouselPage("p2", visibility: Visibility(platform: ["android"])),
            carouselPage("p3"),
        ])
        // Two pages, in order, and no placeholder where p2 was — the old
        // behaviour left a blank page here plus a dot for it.
        XCTAssertEqual(nodeIds(view.pages), ["p1", "p3"])
    }

    func test_carousel_dropsAPageHiddenByTheContextAppVersion() throws {
        let pages = [carouselPage("p1"), carouselPage("p2", visibility: Visibility(minAppVersion: "2.0.0"))]
        // Same node list, two contexts: only ctx.appVersion differs, so this
        // fails if the filter stops reading it.
        XCTAssertEqual(nodeIds(try carousel(pages, appVersion: "1.9.9").pages), ["p1"])
        XCTAssertEqual(nodeIds(try carousel(pages, appVersion: "2.0.0").pages), ["p1", "p2"])
    }

    func test_carousel_everyPageHiddenLeavesNoRenderablePages() throws {
        let view = try carousel([
            carouselPage("p1", visibility: Visibility(platform: ["android"])),
            carouselPage("p2", visibility: Visibility(platform: ["web"])),
        ])
        // Empty is what puts `body` on the same branch an authored-empty
        // carousel takes: render `fallback`, else nothing — never N blank
        // pages with N dots.
        XCTAssertTrue(view.pages.isEmpty)
    }

    func test_carousel_keepsEveryPageWhenNoneIsHidden() throws {
        let view = try carousel([carouselPage("p1"), carouselPage("p2")])
        XCTAssertEqual(nodeIds(view.pages), ["p1", "p2"])
    }

    /// The four ways a page can draw nothing WITHOUT being hidden by a
    /// `visibility` rule — the half of the empty-page rule iOS was missing and
    /// Android already had. Each is a page whose renderer legitimately
    /// produces no content: an undecodable node type with nowhere to fall back
    /// to, an icon name that maps to no SF Symbol, a countdown carrying
    /// neither `endsAt` nor `durationSeconds`, and a nested carousel with no
    /// pages of its own.
    private var emptyCarouselPages: [BuilderNode] {
        [
            .unknown(id: "unknownPage", visibility: nil, fallback: nil),
            .icon(IconProps(id: "unknownIconPage", name: "definitely-not-a-registry-icon")),
            .countdown(CountdownProps(id: "deadlinelessPage")),
            .carousel(CarouselProps(id: "nestedEmptyPage", children: [])),
        ]
    }

    func test_carousel_dropsEveryPageThatDrawsNothingEvenWhenVisible() throws {
        let view = try carousel([carouselPage("p1")] + emptyCarouselPages + [carouselPage("p2")])
        // The two real pages survive, in order, and nothing stands in for the
        // four that draw nothing — each of those used to be a blank swipeable
        // page with a dot of its own.
        XCTAssertEqual(nodeIds(view.pages), ["p1", "p2"])
    }

    func test_carousel_everyPageDrawingNothingLeavesNoRenderablePages() throws {
        // Same branch an authored-empty carousel takes: `fallback`, else
        // nothing — never four blank pages with four dots.
        XCTAssertTrue(try carousel(emptyCarouselPages).pages.isEmpty)
    }

    /// A page kept because its own `fallback` draws is the other half of the
    /// rule: "renders nothing" means nothing at all, not "the primary content
    /// was undecidable". Without this, the drop could be over-eager in exactly
    /// the direction that loses authored content.
    func test_carousel_keepsAnUndecidablePageWhoseFallbackDraws() throws {
        let deadlineless = BuilderNode.countdown(
            CountdownProps(id: "cd", fallback: BuilderNodeBox(node: carouselPage("cdFallback"))))
        let unknown = BuilderNode.unknown(
            id: "u", visibility: nil, fallback: BuilderNodeBox(node: carouselPage("uFallback")))
        let view = try carousel([deadlineless, unknown])
        XCTAssertEqual(view.pages.count, 2)
    }

    /// A restore button is dropped when there is no handler to route it to —
    /// `ActionButtonView` renders nothing in that case, so the page is empty.
    /// `makeCtx` builds a context with `onRestore: nil`, which is the whole
    /// point: the same node is kept as a page the moment a handler exists, so
    /// this cannot pass by ignoring the context.
    func test_carousel_dropsARestoreButtonPageWithNoHandler() throws {
        let restore = BuilderNode.button(
            ButtonProps(id: "b1", labelKey: "k", style: .primary, action: .restore))
        XCTAssertTrue(try carousel([restore]).pages.isEmpty)

        let withHandler = try makeCtx(appVersion: nil, onRestore: {})
        XCTAssertEqual(renderableCarouselPages([restore], ctx: withHandler, cell: nil).count, 1)
    }

    /// An icon page's `name` is overridable, so the drop rule has to judge the
    /// node AFTER overrides. Both directions, same node: with the override
    /// INACTIVE the unknown authored name stands and the page is dropped; with
    /// it ACTIVE the override's real symbol name wins and the page is kept. A
    /// predicate that ignored overrides would drop it in both, so neither half
    /// can pass on its own.
    func test_carousel_judgesAnIconPageAfterItsOverridesApply() throws {
        let overridden = BuilderNode.icon(
            IconProps(
                id: "ic", name: "definitely-not-a-registry-icon",
                overrides: [NodeOverride(when: .introEligible, props: IconOverrideProps(name: "star"))]))

        // No offering in the default ctx, so `introEligible` is false.
        XCTAssertTrue(try carousel([overridden]).pages.isEmpty)

        let eligibleCtx = try makeCtx(
            appVersion: nil, offering: introEligibleOffering(packageId: "pkg"), selectedPackageId: "pkg")
        XCTAssertEqual(renderableCarouselPages([overridden], ctx: eligibleCtx, cell: nil).count, 1)
    }

    /// An offering whose single package is intro-eligible — the only way to
    /// make an `introEligible` override active, since that condition is
    /// derived from the selected package's product, never set directly.
    private func introEligibleOffering(packageId: String) -> Offering {
        let product = StoreProduct(
            id: "product", type: .subscription, productCategory: .subscription, displayName: "unused",
            description: nil, priceString: nil, price: nil, currencyCode: nil, subscriptionPeriod: nil,
            subscriptionGroupIdentifier: nil, isFamilyShareable: false, introPrice: nil, discounts: [],
            isEligibleForIntroOffer: true, subscriptionOptions: nil, defaultOption: nil, pricePerWeek: nil,
            pricePerMonth: nil, pricePerYear: nil, pricePerWeekString: nil, pricePerMonthString: nil,
            pricePerYearString: nil, rawStoreProduct: nil)
        return Offering(
            identifier: "default", isDefault: true,
            packages: [Package(identifier: packageId, packageType: .custom, product: product)])
    }

    // MARK: - carousel indicator colour
    //
    // Pins the resolved value that feeds `.tint(_:)` — which theme half won,
    // and that it is the authored colour rather than a placeholder.
    //
    // KNOWN LIMIT, stated plainly: what happens AFTER `.tint(_:)` — whether
    // SwiftUI actually recolours `PageTabViewStyle`'s dots, which are a
    // `UIPageControl` underneath and have historically not followed `.tint` —
    // is not observable from any unit test in this package. It stays device
    // smoke item S7. No test here asserts it, because such a test would pass
    // whether the dots recolour or not.

    /// An absent `indicatorColor` resolves to the paywall's ambient ink, NOT
    /// to "no tint" — this test previously pinned the opposite, which is the
    /// divergence being closed: leaving `.tint` off lets `PageTabViewStyle`
    /// draw its own white-ish dots, near-invisible on a light paywall, while
    /// web and Android both substituted a concrete ink. Pinned by component
    /// per theme, and against `textInkDefaultColor`'s own halves, so it is the
    /// SAME ink the other two resolve (#0F172A light / #F8FAFC dark) rather
    /// than merely "something non-nil".
    func test_carousel_absentIndicatorColorResolvesToTheAmbientInk() throws {
        let light = try XCTUnwrap(try carousel([carouselPage("p1")]).indicatorRGBA)
        let expectedLight = try XCTUnwrap(parseHexColor(textInkDefaultColor.light))
        XCTAssertEqual(light.red, expectedLight.red, accuracy: colorComponentAccuracy)
        XCTAssertEqual(light.green, expectedLight.green, accuracy: colorComponentAccuracy)
        XCTAssertEqual(light.blue, expectedLight.blue, accuracy: colorComponentAccuracy)
        XCTAssertEqual(light.alpha, 1.0, accuracy: colorComponentAccuracy)

        let dark = try XCTUnwrap(try carousel([carouselPage("p1")], dark: true).indicatorRGBA)
        let expectedDark = try XCTUnwrap(parseHexColor(try XCTUnwrap(textInkDefaultColor.dark)))
        XCTAssertEqual(dark.red, expectedDark.red, accuracy: colorComponentAccuracy)
        XCTAssertEqual(dark.green, expectedDark.green, accuracy: colorComponentAccuracy)
        XCTAssertEqual(dark.blue, expectedDark.blue, accuracy: colorComponentAccuracy)

        // ...and the two halves are genuinely different inks, so a resolver
        // that ignored `dark` and returned the light half twice fails here.
        XCTAssertNotEqual(light.red, dark.red, accuracy: colorComponentAccuracy)
    }

    /// The concrete cross-platform value, pinned once against the literal the
    /// other two renderers carry (NodeViewFactory.kt's TEXT_INK_DEFAULT_COLOR,
    /// styles.ts's DEFAULT_INK). The test above pins the carousel's resolution
    /// against this constant; this pins the constant itself, so drifting it
    /// away from the other platforms fails here rather than silently agreeing
    /// with itself.
    func test_textInkDefaultColor_matchesTheOtherTwoRenderersInk() {
        XCTAssertEqual(textInkDefaultColor.light, "#0F172A")
        XCTAssertEqual(textInkDefaultColor.dark, "#F8FAFC")
    }

    /// An unparsable explicit colour is a decode failure, not an instruction
    /// to go back to invisible dots — it lands on the ink, as Android's
    /// `resolvedInkTintColorInt` does.
    func test_carousel_unparsableIndicatorColorFallsBackToTheInk() throws {
        let garbage = ThemePair(light: "not-a-hex-colour", dark: "also-not")
        let resolved = try XCTUnwrap(try carousel([carouselPage("p1")], indicatorColor: garbage).indicatorRGBA)
        let expected = try XCTUnwrap(parseHexColor(textInkDefaultColor.light))
        XCTAssertEqual(resolved.red, expected.red, accuracy: colorComponentAccuracy)
        XCTAssertEqual(resolved.green, expected.green, accuracy: colorComponentAccuracy)
        XCTAssertEqual(resolved.blue, expected.blue, accuracy: colorComponentAccuracy)
    }

    func test_carousel_indicatorColorResolvesThePerThemeHalfByValue() throws {
        // Pure red light / pure blue dark: asserted by component, so a wrong
        // theme half or a placeholder colour cannot pass.
        let pair = ThemePair(light: "#FF0000", dark: "#0000FF")
        let pages = [carouselPage("p1")]

        let light = try XCTUnwrap(try carousel(pages, indicatorColor: pair).indicatorRGBA)
        XCTAssertEqual(light.red, 1.0, accuracy: colorComponentAccuracy)
        XCTAssertEqual(light.green, 0.0, accuracy: colorComponentAccuracy)
        XCTAssertEqual(light.blue, 0.0, accuracy: colorComponentAccuracy)
        XCTAssertEqual(light.alpha, 1.0, accuracy: colorComponentAccuracy)

        let dark = try XCTUnwrap(try carousel(pages, indicatorColor: pair, dark: true).indicatorRGBA)
        XCTAssertEqual(dark.red, 0.0, accuracy: colorComponentAccuracy)
        XCTAssertEqual(dark.blue, 1.0, accuracy: colorComponentAccuracy)
    }

    // MARK: - node visibility: one rule for every time-driven node (D2)
    //
    // SwiftUI has no `IntersectionObserver`, so the on-screen question is
    // answered by comparing a node's frame in the paywall's named viewport
    // coordinate space against that viewport's own frame. The DECISION is a
    // pure function and is pinned here; the PLUMBING that feeds it real rects
    // (the `GeometryReader` background, the named coordinate space, the
    // `scenePhase` watch) is not observable from a unit test in this package
    // and stays a device-smoke item. Nothing below pretends otherwise: these
    // never prove SwiftUI hands the modifier a real frame, only what the rule
    // decides once it has one.

    func test_nodeFullyInsideTheViewportIsOnScreen() {
        XCTAssertTrue(isNodeOnScreen(
            nodeFrame: CGRect(x: 0, y: 100, width: 300, height: 200),
            viewportFrame: CGRect(x: 0, y: 0, width: 300, height: 600)))
    }

    func test_nodeScrolledFullyAboveTheViewportIsOffScreen() {
        XCTAssertFalse(isNodeOnScreen(
            nodeFrame: CGRect(x: 0, y: -300, width: 300, height: 200),
            viewportFrame: CGRect(x: 0, y: 0, width: 300, height: 600)))
    }

    func test_partiallyVisibleNodeCountsAsOnScreen() {
        XCTAssertTrue(isNodeOnScreen(
            nodeFrame: CGRect(x: 0, y: 550, width: 300, height: 200),
            viewportFrame: CGRect(x: 0, y: 0, width: 300, height: 600)))
    }

    func test_aZeroSizedViewportFailsOpen() {
        XCTAssertTrue(isNodeOnScreen(
            nodeFrame: CGRect(x: 0, y: 0, width: 300, height: 200),
            viewportFrame: .zero))
    }

    /// The mirror of the scrolled-above case: a node still below the fold has
    /// not been reached yet and must not be running either.
    func test_nodeScrolledFullyBelowTheViewportIsOffScreen() {
        XCTAssertFalse(isNodeOnScreen(
            nodeFrame: CGRect(x: 0, y: 700, width: 300, height: 200),
            viewportFrame: testViewportFrame))
    }

    /// A node that has not laid out yet (`.zero` frame) inside a REAL viewport
    /// fails open for the same reason the zero viewport does — "we cannot tell
    /// yet" must never read as "off screen", or every timer stops at launch.
    func test_anUnlaidOutNodeFailsOpen() {
        XCTAssertTrue(isNodeOnScreen(nodeFrame: .zero, viewportFrame: testViewportFrame))
    }

    /// The second half of the rule: on screen AND the app in front. Both
    /// consumers go through `isNodeRunning`, so backgrounding pauses them.
    func test_appInTheBackgroundStopsAnOnScreenNode() {
        XCTAssertTrue(isNodeRunning(onScreenState()))
        XCTAssertFalse(isNodeRunning(onScreenState(appIsForeground: false)))
    }

    /// `countdown`'s pause behaviour, through the SAME function
    /// `CountdownView.syncTicking` consults. Scrolled out of the viewport or
    /// with the app away, the clock must not be ticking.
    func test_countdownDoesNotTickWhileOffScreenOrInTheBackground() {
        XCTAssertTrue(countdownShouldTick(visibility: onScreenState()))
        XCTAssertFalse(countdownShouldTick(visibility: offScreenState()))
        XCTAssertFalse(countdownShouldTick(visibility: onScreenState(appIsForeground: false)))
    }

    /// `carousel`'s pause behaviour, through the SAME function
    /// `CarouselView.scheduleTimer` consults.
    func test_carouselDoesNotAutoAdvanceWhileOffScreenOrInTheBackground() {
        XCTAssertTrue(autoAdvanceDecision(visibility: onScreenState()))
        XCTAssertFalse(autoAdvanceDecision(visibility: offScreenState()))
        XCTAssertFalse(autoAdvanceDecision(visibility: onScreenState(appIsForeground: false)))
    }

    /// Pausing is NOT reaching the last page. A `loop: false` carousel that
    /// was scrolled away mid-run keeps advancing when it comes back; only the
    /// latch that `advance()` sets on the real last page stops it for good.
    func test_carouselStopLatchSurvivesAPauseResumeCycle() {
        // Running, then paused off screen, then back — the latch was never
        // set, so the resumed carousel must schedule again.
        XCTAssertTrue(autoAdvanceDecision(visibility: onScreenState()))
        XCTAssertFalse(autoAdvanceDecision(visibility: offScreenState()))
        XCTAssertTrue(autoAdvanceDecision(visibility: onScreenState()))
        // ...and a carousel that genuinely finished stays stopped across the
        // same cycle, so the resume path cannot be "always reschedule".
        XCTAssertFalse(autoAdvanceDecision(visibility: onScreenState(), stoppedAtEnd: true))
    }

    /// The visibility rule is added to the auto-advance preconditions, never
    /// substituted for them: no interval, a non-positive interval, or a single
    /// page still means no timer even with the node fully on screen.
    func test_carouselAutoAdvanceStillHonoursItsOwnPreconditions() {
        XCTAssertFalse(autoAdvanceDecision(visibility: onScreenState(), autoAdvanceSeconds: nil))
        XCTAssertFalse(autoAdvanceDecision(visibility: onScreenState(), autoAdvanceSeconds: 0))
        XCTAssertFalse(autoAdvanceDecision(visibility: onScreenState(), pageCount: 1))
    }

    /// A 300x600 stand-in for the paywall's scroll viewport, the same rect the
    /// brief's cases use.
    private var testViewportFrame: CGRect { CGRect(x: 0, y: 0, width: 300, height: 600) }

    private func onScreenState(appIsForeground: Bool = true) -> NodeVisibilityState {
        NodeVisibilityState(
            nodeFrame: CGRect(x: 0, y: 100, width: 300, height: 200),
            viewportFrame: testViewportFrame, appIsForeground: appIsForeground)
    }

    private func offScreenState(appIsForeground: Bool = true) -> NodeVisibilityState {
        NodeVisibilityState(
            nodeFrame: CGRect(x: 0, y: -300, width: 300, height: 200),
            viewportFrame: testViewportFrame, appIsForeground: appIsForeground)
    }

    /// Defaults that keep every carousel case above about the ONE variable it
    /// names: a two-page carousel with a real interval and no stop latch is
    /// the shape that would be running if nothing paused it.
    private func autoAdvanceDecision(
        visibility: NodeVisibilityState, autoAdvanceSeconds: Double? = 3, pageCount: Int = 2,
        stoppedAtEnd: Bool = false
    ) -> Bool {
        carouselShouldAutoAdvance(
            visibility: visibility, autoAdvanceSeconds: autoAdvanceSeconds, pageCount: pageCount,
            stoppedAtEnd: stoppedAtEnd)
    }
}

/// Tolerance for a parsed 8-bit colour channel compared against its unit
/// value — the parse divides by 255, so exact `==` on a `Double` is the wrong
/// assertion shape even when it happens to hold.
private let colorComponentAccuracy = 1e-9
