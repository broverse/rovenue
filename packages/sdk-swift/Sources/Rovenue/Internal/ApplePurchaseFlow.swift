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

import Foundation

internal struct ApplePurchaseFlow {
    let store: AppleStore
    let validate: @Sendable (_ jws: String, _ productId: String) async throws -> ReceiptResult

    func run(productId: String, appAccountToken: String?) async throws -> PurchaseResult {
        let outcome = try await store.purchase(productId: productId, appAccountToken: appAccountToken)
        switch outcome {
        case .userCancelled:
            throw Rovenue.Error.purchaseCancelled
        case .pending:
            throw Rovenue.Error.purchasePending
        case .productNotFound:
            throw Rovenue.Error.productNotAvailable
        case let .success(jws, transactionId, finish):
            let receipt = try await validate(jws, productId)
            await finish()
            return PurchaseResult(
                entitlements: receipt.entitlements,
                creditBalance: receipt.creditBalance,
                productId: productId,
                storeTransactionId: transactionId
            )
        }
    }
}
