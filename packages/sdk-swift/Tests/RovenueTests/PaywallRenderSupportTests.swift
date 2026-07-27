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
            appVersion: appVersion
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
    }

    // MARK: - scroll container (Task 2, wave C)
    //
    // Deliberately the weakest test in this plan: it pins that a ScrollView
    // is composed into `RovenuePaywallView.body` at all, not that the
    // viewport-minimum (`.frame(minHeight: proxy.size.height)`) actually
    // works — SwiftUI views aren't inspectable without a view-testing
    // dependency this package doesn't carry. It still catches the coarser
    // regression of the ScrollView being removed outright; the real check
    // for the viewport minimum is the device smoke session.

    func test_body_composesAScrollViewAroundTheRootContent() throws {
        let json = """
        {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{"k":"x"}},
         "root":{"type":"stack","id":"root","axis":"v","children":[{"type":"text","id":"t1","key":"k","role":"body"}]}}
        """
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
        let view = RovenuePaywallView(paywall: paywall)
        let bodyTypeDescription = String(describing: type(of: view.body))
        XCTAssertTrue(
            bodyTypeDescription.contains("ScrollView"),
            "expected the paywall root's body to compose a ScrollView, got: \(bodyTypeDescription)"
        )
    }
}
