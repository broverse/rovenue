//
//  PreviewModeTests.swift
//  Covers the P9 "preview must never charge" fix: the pure `purchaseGate`
//  decision, `RovenuePaywallView`'s `previewMode` default/pass-through, and
//  that `RovenuePaywallPreviewView` always wraps with `previewMode: true`.
//

import XCTest
@testable import Rovenue

final class PreviewModeTests: XCTestCase {

    // MARK: - purchaseGate (pure)

    func test_purchaseGate_previewModeFalse_allowsPurchase() {
        XCTAssertTrue(purchaseGate(previewMode: false))
    }

    func test_purchaseGate_previewModeTrue_blocksPurchase() {
        XCTAssertFalse(purchaseGate(previewMode: true))
    }

    // MARK: - RovenuePaywallView.previewMode wiring

    private static let minimalPaywallJson = """
    {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{"k":"x"}},
     "root":{"type":"stack","id":"root","axis":"v","children":[{"type":"text","id":"t1","key":"k","role":"body"}]}}
    """

    private func minimalPaywall() -> Paywall {
        Paywall(
            placementIdentifier: "plc_1",
            placementRevision: 1,
            paywallIdentifier: "pw_1",
            paywallName: "Test",
            configFormatVersion: 2,
            remoteConfig: nil,
            remoteConfigLocale: nil,
            builderConfigJson: Self.minimalPaywallJson,
            offering: nil,
            presentedContext: nil
        )
    }

    /// Mirror reads a struct's stored properties regardless of Swift's
    /// (compile-time-only) access control, so this is enough to pin
    /// `previewMode`'s default without a SwiftUI view-testing dependency
    /// this package doesn't carry (see `PaywallRenderSupportTests`'s
    /// `bodyTypeDescription` doc for the same constraint).
    private func previewModeField(of view: RovenuePaywallView) throws -> Bool {
        try XCTUnwrap(
            Mirror(reflecting: view).children.first(where: { $0.label == "previewMode" })?.value as? Bool
        )
    }

    func test_previewMode_defaultsToFalse() throws {
        let view = RovenuePaywallView(paywall: minimalPaywall())
        XCTAssertFalse(try previewModeField(of: view))
    }

    func test_previewMode_passesThroughWhenExplicitlyTrue() throws {
        let view = RovenuePaywallView(paywall: minimalPaywall(), previewMode: true)
        XCTAssertTrue(try previewModeField(of: view))
    }

    // MARK: - RovenuePaywallPreviewView always wraps with previewMode: true

    func test_previewPaywallView_wrapsTheRenderedPaywallWithPreviewModeTrue() throws {
        let previewView = RovenuePaywallPreviewView(token: "tok")
        let wrapped = previewView.buildWrappedView(shown: minimalPaywall())
        XCTAssertTrue(try previewModeField(of: wrapped))
    }
}
