//  AppleStore.swift — abstraction over the App Store purchase mechanism so the
//  purchase orchestration (`ApplePurchaseFlow`) can be unit-tested with a fake.
//
//  The real implementation (`StoreKitAppleStore`) wraps StoreKit 2 and CANNOT
//  run under `swift test` (no store, no network) — it is build-verified only.
//  Tests inject a `FakeStore` instead.

import Foundation

/// The outcome of asking the store to run a purchase. `success` carries the
/// signed JWS to validate server-side, the store transaction id, and a
/// `finish` closure the flow must call *after* successful validation so the
/// transaction is only acknowledged once the entitlement is granted.
internal enum StorePurchaseOutcome {
    case success(jws: String, transactionId: String, finish: @Sendable () async -> Void)
    case userCancelled
    case pending
    case productNotFound
}

/// Minimal seam over the App Store. Implementations must be `Sendable` so they
/// can be captured into the `ApplePurchaseFlow` struct across concurrency
/// domains.
internal protocol AppleStore: Sendable {
    func purchase(productId: String, appAccountToken: String?) async throws -> StorePurchaseOutcome
}
