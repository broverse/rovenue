//  ApplePurchaseFlowTests.swift — unit tests for the public purchase types,
//  the new purchase-flow error cases, and the testable `ApplePurchaseFlow`
//  orchestration (driven by a fake `AppleStore` + injected validate/snapshot
//  closures). Real StoreKit (`StoreKitAppleStore`) and the validation HTTP
//  call cannot run under `swift test`, so they are build-verified only.

import XCTest
@testable import Rovenue

final class PurchaseTypesTests: XCTestCase {
    func test_storeProduct_shape() {
        let p = StoreProduct(
            id: "premium_monthly",
            type: .subscription,
            productCategory: .subscription,
            displayName: "Premium Monthly",
            description: nil,
            priceString: "$9.99",
            price: Decimal(string: "9.99"),
            currencyCode: "USD",
            subscriptionPeriod: nil,
            subscriptionGroupIdentifier: nil,
            isFamilyShareable: false,
            introPrice: nil,
            discounts: [],
            isEligibleForIntroOffer: nil,
            subscriptionOptions: nil,
            defaultOption: nil,
            pricePerWeek: nil,
            pricePerMonth: nil,
            pricePerYear: nil,
            pricePerWeekString: nil,
            pricePerMonthString: nil,
            pricePerYearString: nil,
            rawStoreProduct: nil
        )
        XCTAssertEqual(p.id, "premium_monthly")
        XCTAssertEqual(p.type, .subscription)
        XCTAssertEqual(p.displayName, "Premium Monthly")
        XCTAssertEqual(p.priceString, "$9.99")
        XCTAssertEqual(p.price, Decimal(string: "9.99"))
        XCTAssertEqual(p.currencyCode, "USD")
    }

    func test_storeProduct_defaults_are_nil() {
        let p = StoreProduct(
            id: "coins_100",
            type: .consumable,
            productCategory: .nonSubscription,
            displayName: "100 Coins",
            description: nil,
            priceString: nil,
            price: nil,
            currencyCode: nil,
            subscriptionPeriod: nil,
            subscriptionGroupIdentifier: nil,
            isFamilyShareable: false,
            introPrice: nil,
            discounts: [],
            isEligibleForIntroOffer: nil,
            subscriptionOptions: nil,
            defaultOption: nil,
            pricePerWeek: nil,
            pricePerMonth: nil,
            pricePerYear: nil,
            pricePerWeekString: nil,
            pricePerMonthString: nil,
            pricePerYearString: nil,
            rawStoreProduct: nil
        )
        XCTAssertNil(p.priceString)
        XCTAssertNil(p.price)
        XCTAssertNil(p.currencyCode)
    }

    func test_productType_from_raw() {
        XCTAssertEqual(ProductType.from("CONSUMABLE"), .consumable)
        XCTAssertEqual(ProductType.from("NON_CONSUMABLE"), .nonConsumable)
        XCTAssertEqual(ProductType.from("SUBSCRIPTION"), .subscription)
        XCTAssertEqual(ProductType.from("anything-else"), .subscription)
    }

    func test_package_and_offering_shape() {
        let prod = StoreProduct(
            id: "premium_monthly",
            type: .subscription,
            productCategory: .subscription,
            displayName: "Premium",
            description: nil,
            priceString: nil,
            price: nil,
            currencyCode: nil,
            subscriptionPeriod: nil,
            subscriptionGroupIdentifier: nil,
            isFamilyShareable: false,
            introPrice: nil,
            discounts: [],
            isEligibleForIntroOffer: nil,
            subscriptionOptions: nil,
            defaultOption: nil,
            pricePerWeek: nil,
            pricePerMonth: nil,
            pricePerYear: nil,
            pricePerWeekString: nil,
            pricePerMonthString: nil,
            pricePerYearString: nil,
            rawStoreProduct: nil
        )
        let pkg = Package(identifier: "$rov_monthly", packageType: .custom, product: prod)
        XCTAssertEqual(pkg.identifier, "$rov_monthly")
        XCTAssertEqual(pkg.product, prod)

        let off = Offering(identifier: "default", isDefault: true, packages: [pkg])
        XCTAssertEqual(off.identifier, "default")
        XCTAssertTrue(off.isDefault)
        XCTAssertEqual(off.packages, [pkg])
    }

    func test_offerings_shape() {
        let prod = StoreProduct(
            id: "premium_monthly",
            type: .subscription,
            productCategory: .subscription,
            displayName: "Premium",
            description: nil,
            priceString: nil,
            price: nil,
            currencyCode: nil,
            subscriptionPeriod: nil,
            subscriptionGroupIdentifier: nil,
            isFamilyShareable: false,
            introPrice: nil,
            discounts: [],
            isEligibleForIntroOffer: nil,
            subscriptionOptions: nil,
            defaultOption: nil,
            pricePerWeek: nil,
            pricePerMonth: nil,
            pricePerYear: nil,
            pricePerWeekString: nil,
            pricePerMonthString: nil,
            pricePerYearString: nil,
            rawStoreProduct: nil
        )
        let pkg = Package(identifier: "$rov_monthly", packageType: .custom, product: prod)
        let off = Offering(identifier: "default", isDefault: true, packages: [pkg])
        let offerings = Offerings(current: off, all: ["default": off])
        XCTAssertEqual(offerings.current, off)
        XCTAssertEqual(offerings.all["default"], off)
        XCTAssertEqual(offerings.all.count, 1)
    }

    func test_offerings_nil_current() {
        let offerings = Offerings(current: nil, all: [:])
        XCTAssertNil(offerings.current)
        XCTAssertTrue(offerings.all.isEmpty)
    }
}

// A fake AppleStore that returns a scripted outcome and records whether
// `finish()` was invoked (via an actor-backed flag the success closure flips).
private actor FinishFlag {
    private(set) var finished = false
    func mark() { finished = true }
}

private struct FakeStore: AppleStore {
    let outcome: StorePurchaseOutcome
    func purchase(productId: String, appAccountToken: String?, signedOffer: AppleSignedOffer?) async throws -> StorePurchaseOutcome {
        outcome
    }
}

private func noSignOffer(_ productId: String, _ offerId: String, _ token: String) async throws -> AppleSignedOffer {
    throw RovenueError(kind: .storeProblem, message: "signOffer should not be called in this test")
}

final class ApplePurchaseFlowOrchestrationTests: XCTestCase {
    private func sampleEntitlement() -> Entitlement {
        Entitlement(id: "ent_1", isActive: true, productIdentifier: "premium_monthly", store: "APP_STORE", expiresIso: nil)
    }

    func test_userCancelled_throws_purchaseCanceled_and_does_not_validate() async {
        let validated = FinishFlag()
        let flow = ApplePurchaseFlow(
            store: FakeStore(outcome: .userCancelled),
            validate: { _, _ in
                await validated.mark()
                return ReceiptResult(subscriberId: "s", appUserId: "u", virtualCurrencies: [:], entitlements: [])
            },
            signOffer: noSignOffer
        )
        do {
            _ = try await flow.run(productId: "premium_monthly", appAccountToken: nil)
            XCTFail("expected purchaseCanceled")
        } catch let e as RovenueError {
            XCTAssertEqual(e.kind, .purchaseCanceled)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        let didValidate = await validated.finished
        XCTAssertFalse(didValidate, "validate must not run on cancel")
    }

    /// Deferred (Ask-to-Buy / pending) purchases do NOT throw — they return a
    /// `PurchaseResult` with `isDeferred = true` and empty entitlements.
    func test_pending_returns_deferred_result() async throws {
        let flow = ApplePurchaseFlow(
            store: FakeStore(outcome: .pending),
            validate: { _, _ in ReceiptResult(subscriberId: "s", appUserId: "u", virtualCurrencies: [:], entitlements: []) },
            signOffer: noSignOffer
        )
        let result = try await flow.run(productId: "premium_monthly", appAccountToken: nil)
        XCTAssertTrue(result.isDeferred, "pending outcome must set isDeferred")
        XCTAssertTrue(result.entitlements.isEmpty, "deferred result has no entitlements yet")
        XCTAssertEqual(result.productId, "premium_monthly")
    }

    func test_productNotFound_throws_productNotAvailable() async {
        let flow = ApplePurchaseFlow(
            store: FakeStore(outcome: .productNotFound),
            validate: { _, _ in ReceiptResult(subscriberId: "s", appUserId: "u", virtualCurrencies: [:], entitlements: []) },
            signOffer: noSignOffer
        )
        do {
            _ = try await flow.run(productId: "premium_monthly", appAccountToken: nil)
            XCTFail("expected productNotAvailable")
        } catch let e as RovenueError {
            XCTAssertEqual(e.kind, .productNotAvailable)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func test_success_validates_then_finishes_then_returns_result() async throws {
        let finished = FinishFlag()
        var capturedJws: String?
        var capturedProductId: String?
        let flow = ApplePurchaseFlow(
            store: FakeStore(outcome: .success(jws: "jws-blob", transactionId: "txn-42", finish: {
                await finished.mark()
            })),
            validate: { jws, pid in
                capturedJws = jws
                capturedProductId = pid
                // finish must NOT have run before validation succeeds.
                let wasFinished = await finished.finished
                XCTAssertFalse(wasFinished, "finish() must run after validate, not before")
                return ReceiptResult(subscriberId: "sub_1", appUserId: "user_1", virtualCurrencies: ["COIN": 250], entitlements: [self.sampleEntitlement()])
            },
            signOffer: noSignOffer
        )

        let result = try await flow.run(productId: "premium_monthly", appAccountToken: "tok")

        XCTAssertEqual(capturedJws, "jws-blob")
        XCTAssertEqual(capturedProductId, "premium_monthly")
        let didFinish = await finished.finished
        XCTAssertTrue(didFinish, "finish() must run after successful validation")
        XCTAssertEqual(result.virtualCurrencies, ["COIN": 250])
        XCTAssertEqual(result.productId, "premium_monthly")
        XCTAssertEqual(result.storeTransactionId, "txn-42")
        XCTAssertEqual(result.entitlements, [sampleEntitlement()])
        XCTAssertFalse(result.isDeferred)
    }

    func test_validation_throws_then_finish_not_called_and_error_propagates() async {
        let finished = FinishFlag()
        let flow = ApplePurchaseFlow(
            store: FakeStore(outcome: .success(jws: "jws-blob", transactionId: "txn-99", finish: {
                await finished.mark()
            })),
            validate: { _, _ in
                throw RovenueError(kind: .receiptInvalid, message: "Receipt could not be validated")
            },
            signOffer: noSignOffer
        )
        do {
            _ = try await flow.run(productId: "premium_monthly", appAccountToken: nil)
            XCTFail("expected validation error to propagate")
        } catch let e as RovenueError {
            XCTAssertEqual(e.kind, .receiptInvalid)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        let didFinish = await finished.finished
        XCTAssertFalse(didFinish, "finish() must NOT run when validation throws")
    }
}

final class PurchaseErrorTests: XCTestCase {
    func test_purchaseResult_isDeferred_defaults_false() {
        let result = PurchaseResult(
            entitlements: [],
            virtualCurrencies: [:],
            productId: "p",
            storeTransactionId: "t"
        )
        XCTAssertFalse(result.isDeferred)
    }

    func test_purchaseResult_isDeferred_can_be_true() {
        let result = PurchaseResult(
            entitlements: [],
            virtualCurrencies: [:],
            productId: "p",
            storeTransactionId: "",
            isDeferred: true
        )
        XCTAssertTrue(result.isDeferred)
    }

    func test_purchase_rovenueError_kinds_exist() {
        // Verify the ErrorKind cases used by the purchase flow are accessible.
        let kinds: [ErrorKind] = [
            .purchaseCanceled,
            .productNotAvailable,
            .alreadyOwned,
            .paymentDeclined,
            .storeServiceUnavailable,
            .ineligible,
            .storeProblem,
            .receiptInvalid,
        ]
        XCTAssertEqual(kinds.count, 8)
    }

    func test_purchase_errors_have_messages() {
        let e1 = RovenueError(kind: .purchaseCanceled, message: "cancelled")
        let e2 = RovenueError(kind: .productNotAvailable, message: "not available")
        let e3 = RovenueError(kind: .storeProblem, message: "store problem")
        XCTAssertNotNil(e1.errorDescription)
        XCTAssertNotNil(e2.errorDescription)
        XCTAssertNotNil(e3.errorDescription)
    }
}
