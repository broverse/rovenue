//  ApplePurchaseFlow.swift — pure, testable purchase orchestration.
//
//  Sequencing guarantees:
//    1. ask the store to run the purchase;
//    2. on success, validate the JWS server-side BEFORE finishing the
//       transaction (so a validation failure leaves the transaction
//       un-finished and StoreKit re-delivers it later);
//    3. only after validation succeeds, finish() the transaction;
//    4. return the entitlements already hydrated into ReceiptResult by the
//       core (no separate cache read needed).
//
//  Store interaction (`AppleStore`) and validation (`validate`) are injected,
//  so this type is fully unit-testable with fakes — no StoreKit, no network.
//
//  Deferred / Ask-to-Buy: a `.pending` outcome is NOT an error. The flow
//  returns a `PurchaseResult` with empty entitlements and `isDeferred = true`
//  so the caller can surface the appropriate UI without special-casing `catch`.

import Foundation

internal struct ApplePurchaseFlow {
    let store: AppleStore
    let validate: @Sendable (_ jws: String, _ productId: String) async throws -> ReceiptResult
    let signOffer: @Sendable (_ productId: String, _ offerId: String, _ appAccountToken: String) async throws -> AppleSignedOffer

    func run(productId: String, appAccountToken: String?, promotionalOfferId: String? = nil) async throws -> PurchaseResult {
        var signedOffer: AppleSignedOffer?
        if let offerId = promotionalOfferId {
            signedOffer = try await signOffer(productId, offerId, appAccountToken ?? "")
        }
        let outcome = try await store.purchase(productId: productId, appAccountToken: appAccountToken, signedOffer: signedOffer)
        switch outcome {
        case .userCancelled:
            throw RovenueError(kind: .purchaseCanceled, message: "The purchase was cancelled by the user")
        case .pending:
            // Deferred purchase (Ask to Buy, etc.) — not an error.
            return PurchaseResult(
                entitlements: [],
                virtualCurrencies: [:],
                productId: productId,
                storeTransactionId: "",
                isDeferred: true
            )
        case .productNotFound:
            throw RovenueError(kind: .productNotAvailable, message: "The requested product is not available from the store")
        case .alreadyOwned:
            throw RovenueError(kind: .alreadyOwned, message: "You already own this product")
        case .paymentDeclined:
            throw RovenueError(kind: .paymentDeclined, message: "Payment was declined")
        case .serviceUnavailable:
            throw RovenueError(kind: .storeServiceUnavailable, message: "The App Store is temporarily unavailable")
        case .ineligible:
            throw RovenueError(kind: .ineligible, message: "You are not eligible for this offer")
        case .productNotAvailableInStorefront:
            throw RovenueError(kind: .productNotAvailable, message: "This product is not available in your storefront")
        case let .success(jws, transactionId, finish):
            let receipt = try await validate(jws, productId)
            await finish()
            return PurchaseResult(
                entitlements: receipt.entitlements,
                virtualCurrencies: receipt.virtualCurrencies,
                productId: productId,
                storeTransactionId: transactionId
            )
        }
    }
}
