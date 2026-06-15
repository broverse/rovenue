//  AppleStore.swift — abstraction over the App Store purchase mechanism so the
//  purchase orchestration (`ApplePurchaseFlow`) can be unit-tested with a fake.
//
//  The real implementation (`StoreKitAppleStore`) wraps StoreKit 2 and CANNOT
//  run under `swift test` (no store, no network) — it is build-verified only.
//  Tests inject a `FakeStore` instead.

import Foundation
import StoreKit

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

/// The real StoreKit 2 implementation. Build-verified only — never exercised
/// under `swift test` (requires a live App Store / StoreKit testing host).
@available(iOS 15.0, macOS 12.0, *)
internal struct StoreKitAppleStore: AppleStore {
    func purchase(productId: String, appAccountToken: String?) async throws -> StorePurchaseOutcome {
        let products: [Product]
        do {
            products = try await Product.products(for: [productId])
        } catch {
            throw Rovenue.Error.storeProblem
        }
        guard let product = products.first else {
            return .productNotFound
        }

        var options: Set<Product.PurchaseOption> = []
        if let token = appAccountToken, let uuid = UUID(uuidString: token) {
            options.insert(.appAccountToken(uuid))
        }

        let result: Product.PurchaseResult
        do {
            result = try await product.purchase(options: options)
        } catch {
            throw Rovenue.Error.storeProblem
        }

        switch result {
        case .userCancelled:
            return .userCancelled
        case .pending:
            return .pending
        case let .success(verification):
            guard case let .verified(transaction) = verification else {
                throw Rovenue.Error.receiptInvalid
            }
            return .success(
                jws: verification.jwsRepresentation,
                transactionId: String(transaction.id),
                finish: { await transaction.finish() }
            )
        @unknown default:
            throw Rovenue.Error.storeProblem
        }
    }

    /// Best-effort batch lookup of StoreKit products by store id. Returns an
    /// empty map on any failure (offerings still render, just without prices).
    func products(for ids: [String]) async -> [String: Product] {
        guard !ids.isEmpty else { return [:] }
        do {
            let products = try await Product.products(for: ids)
            return Dictionary(uniqueKeysWithValues: products.map { ($0.id, $0) })
        } catch {
            return [:]
        }
    }
}
