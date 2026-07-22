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
}
