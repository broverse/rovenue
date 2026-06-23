//  PromotionalOfferPurchaseTests.swift — unit tests for promotional-offer
//  signing and injection into the `ApplePurchaseFlow` pipeline.
//
//  Uses a `CapturingStore` (a fake `AppleStore`) to record the `signedOffer`
//  that the flow passes, and a fake `signOffer` closure to control the
//  `AppleSignedOffer` returned by the server-side signing step.
//  Real StoreKit and the signing HTTP call are never exercised here.

import XCTest
@testable import Rovenue

@available(iOS 15.0, macOS 12.0, *)
final class PromotionalOfferPurchaseTests: XCTestCase {

    // A capturing fake that records the `signedOffer` and `appAccountToken`
    // the flow passes so tests can assert the correct values are threaded through.
    final class CapturingStore: AppleStore, @unchecked Sendable {
        var capturedOffer: AppleSignedOffer?
        var capturedToken: String?
        func purchase(productId: String, appAccountToken: String?, signedOffer: AppleSignedOffer?) async throws -> StorePurchaseOutcome {
            capturedOffer = signedOffer
            capturedToken = appAccountToken
            return .success(jws: "jws", transactionId: "t1", finish: {})
        }
    }

    func testPromotionalOfferIsSignedAndInjected() async throws {
        let store = CapturingStore()
        var signArgs: (String, String, String)?
        let flow = ApplePurchaseFlow(
            store: store,
            validate: { _, _ in ReceiptResult(subscriberId: "s", appUserId: "u", virtualCurrencies: [:], entitlements: []) },
            signOffer: { productId, offerId, token in
                signArgs = (productId, offerId, token)
                return AppleSignedOffer(offerId: offerId, keyId: "K", nonce: "11111111-1111-1111-1111-111111111111", signatureBase64: "AAAA", timestamp: 123)
            }
        )
        _ = try await flow.run(productId: "premium_monthly", appAccountToken: "abc", promotionalOfferId: "winback10")
        XCTAssertEqual(store.capturedOffer?.offerId, "winback10")
        XCTAssertEqual(store.capturedOffer?.keyId, "K")
        XCTAssertEqual(store.capturedToken, "abc")           // same token used for sign + purchase
        XCTAssertEqual(signArgs?.0, "premium_monthly")
        XCTAssertEqual(signArgs?.1, "winback10")
        XCTAssertEqual(signArgs?.2, "abc")
    }

    func testNoOfferDoesNotSign() async throws {
        let store = CapturingStore()
        var signCalled = false
        let flow = ApplePurchaseFlow(
            store: store,
            validate: { _, _ in ReceiptResult(subscriberId: "s", appUserId: "u", virtualCurrencies: [:], entitlements: []) },
            signOffer: { _, _, _ in signCalled = true; return AppleSignedOffer(offerId: "", keyId: "", nonce: "", signatureBase64: "", timestamp: 0) }
        )
        _ = try await flow.run(productId: "p", appAccountToken: nil, promotionalOfferId: nil)
        XCTAssertNil(store.capturedOffer)
        XCTAssertFalse(signCalled)
    }

    /// Validates that `resolvePromotionalOfferId` rejects `.introductory` offers,
    /// missing identifiers, and returns nil for nil input.
    func testIntroductoryDiscountTypeIsRejected() throws {
        let monthlyPeriod = Period(value: 1, unit: .month, iso8601: "P1M")

        // Test 1: introductory discount throws with .ineligible
        let introDiscount = Discount(
            identifier: "intro_offer",
            price: nil,
            priceString: nil,
            currencyCode: nil,
            period: monthlyPeriod,
            numberOfPeriods: 1,
            paymentMode: .freeTrial,
            type: .introductory
        )
        XCTAssertThrowsError(try resolvePromotionalOfferId(introDiscount)) { error in
            guard let rovenueError = error as? RovenueError else {
                XCTFail("Expected RovenueError, got \(type(of: error))")
                return
            }
            XCTAssertEqual(rovenueError.kind, .ineligible)
            XCTAssertTrue(rovenueError.message.contains("Introductory offers"))
        }

        // Test 2: promotional discount with valid identifier returns the id
        let promoDiscount = Discount(
            identifier: "winback10",
            price: nil,
            priceString: nil,
            currencyCode: nil,
            period: monthlyPeriod,
            numberOfPeriods: 1,
            paymentMode: .payAsYouGo,
            type: .promotional
        )
        let result = try resolvePromotionalOfferId(promoDiscount)
        XCTAssertEqual(result, "winback10")

        // Test 3: discount with nil identifier throws with .ineligible
        let missingIdDiscount = Discount(
            identifier: nil,
            price: nil,
            priceString: nil,
            currencyCode: nil,
            period: monthlyPeriod,
            numberOfPeriods: 1,
            paymentMode: .payAsYouGo,
            type: .promotional
        )
        XCTAssertThrowsError(try resolvePromotionalOfferId(missingIdDiscount)) { error in
            guard let rovenueError = error as? RovenueError else {
                XCTFail("Expected RovenueError, got \(type(of: error))")
                return
            }
            XCTAssertEqual(rovenueError.kind, .ineligible)
            XCTAssertTrue(rovenueError.message.contains("missing an identifier"))
        }

        // Test 4: nil input returns nil
        let nilResult = try resolvePromotionalOfferId(nil)
        XCTAssertNil(nilResult)
    }
}
