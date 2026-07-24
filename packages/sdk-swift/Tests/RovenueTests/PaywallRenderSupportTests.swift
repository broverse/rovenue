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
    // BuilderNodeView.body gates on `isNodeVisible(node.visibility,
    // platform:appVersion:)` BEFORE dispatching to `resolvedContent` — a
    // bare SwiftUI view body isn't unit-testable without a rendering
    // harness, so these pin exactly the predicate call the gate makes,
    // for three representative cases: platform-hidden, a
    // hidden stack (whose children the gate never even reaches, since it
    // returns `EmptyView()` before `resolvedContent`'s switch looks at
    // `props.children`), and a hidden node that still carries a fallback
    // (rendered NEITHER — the fallback is irrelevant to the gate; it can
    // only ever be reached from inside `resolvedContent`, which the gate
    // never enters).

    func test_platformHidden_gateHidesTheNode() {
        let props = TextProps(id: "t1", key: "k", role: .body, visibility: Visibility(platform: ["android"]))
        XCTAssertFalse(isNodeVisible(props.visibility, platform: "ios", appVersion: nil))
    }

    func test_hiddenStack_gateHidesBeforeAnyChildIsReached() {
        let stack = StackProps(
            id: "root", axis: .v,
            children: [
                .text(TextProps(id: "c1", key: "k1", role: .body)),
                .spacer(SpacerProps(id: "c2")),
            ],
            visibility: Visibility(platform: ["android"])
        )
        XCTAssertFalse(isNodeVisible(stack.visibility, platform: "ios", appVersion: nil))
        // The children themselves carry no visibility of their own here —
        // the gate short-circuits on the STACK before BuilderNodeView ever
        // recurses into `stack.children`, so their own visibility is never
        // even consulted for this tree.
        XCTAssertTrue(stack.children.allSatisfy { isNodeVisible($0.visibility, platform: "ios", appVersion: nil) })
    }

    func test_hiddenNodeWithFallback_stillHidden_fallbackNeverRenders() {
        let fallback = BuilderNodeBox(node: .text(TextProps(id: "fb", key: "k2", role: .body)))
        let props = TextProps(
            id: "t1", key: "k", role: .body,
            visibility: Visibility(minAppVersion: "99.0.0"), fallback: fallback
        )
        XCTAssertNotNil(props.fallback, "the node does carry a fallback")
        XCTAssertFalse(
            isNodeVisible(props.visibility, platform: "ios", appVersion: "1.0.0"),
            "a hidden node renders neither its own content nor its fallback"
        )
    }

    func test_noVisibilityRules_gateShowsTheNode() {
        let props = TextProps(id: "t1", key: "k", role: .body)
        XCTAssertTrue(isNodeVisible(props.visibility, platform: "ios", appVersion: nil))
    }
}
