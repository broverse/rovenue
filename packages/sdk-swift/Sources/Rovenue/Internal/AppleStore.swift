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
    /// The purchase is pending external action (Ask to Buy, etc.).
    /// The flow returns a deferred `PurchaseResult` rather than throwing.
    case pending
    case productNotFound
    /// The user already owns this non-consumable / active subscription.
    case alreadyOwned
    /// Payment was declined (e.g. parental controls, insufficient funds signal).
    case paymentDeclined
    /// The App Store is temporarily unreachable.
    case serviceUnavailable
    /// The user is ineligible for the offer (e.g. introductory offer already used).
    case ineligible
    /// The product is not available in the user's storefront.
    case productNotAvailableInStorefront
}

/// Signed promotional-offer material assembled from the server-side signature
/// and passed into StoreKit so Apple can verify it hasn't been tampered with.
internal struct AppleSignedOffer: Sendable {
    let offerId: String
    let keyId: String
    let nonce: String
    let signatureBase64: String
    let timestamp: Int
}

/// Minimal seam over the App Store. Implementations must be `Sendable` so they
/// can be captured into the `ApplePurchaseFlow` struct across concurrency
/// domains.
internal protocol AppleStore: Sendable {
    func purchase(productId: String, appAccountToken: String?, signedOffer: AppleSignedOffer?) async throws -> StorePurchaseOutcome
}

/// The real StoreKit 2 implementation. Build-verified only — never exercised
/// under `swift test` (requires a live App Store / StoreKit testing host).
@available(iOS 15.0, macOS 12.0, *)
internal struct StoreKitAppleStore: AppleStore {
    func purchase(productId: String, appAccountToken: String?, signedOffer: AppleSignedOffer?) async throws -> StorePurchaseOutcome {
        let products: [Product]
        do {
            products = try await Product.products(for: [productId])
        } catch let skErr as StoreKitError {
            switch skErr {
            case .networkError, .systemError:
                return .serviceUnavailable
            case .notAvailableInStorefront:
                return .productNotAvailableInStorefront
            default:
                throw RovenueError(kind: .storeProblem, message: "\(skErr)")
            }
        } catch {
            throw RovenueError(kind: .storeProblem, message: "\(error)")
        }
        guard let product = products.first else {
            return .productNotFound
        }

        var options: Set<Product.PurchaseOption> = []
        if let token = appAccountToken, let uuid = UUID(uuidString: token) {
            options.insert(.appAccountToken(uuid))
        }
        if let o = signedOffer {
            guard let nonceUUID = UUID(uuidString: o.nonce),
                  let sigData = Data(base64Encoded: o.signatureBase64) else {
                return .ineligible   // malformed signature material
            }
            options.insert(.promotionalOffer(offerID: o.offerId, keyID: o.keyId, nonce: nonceUUID, signature: sigData, timestamp: o.timestamp))
        }

        let result: Product.PurchaseResult
        do {
            result = try await product.purchase(options: options)
        } catch let skErr as StoreKitError {
            switch skErr {
            case .networkError, .systemError:
                return .serviceUnavailable
            case .notAvailableInStorefront:
                return .productNotAvailableInStorefront
            default:
                throw RovenueError(kind: .storeProblem, message: "\(skErr)")
            }
        } catch let pErr as Product.PurchaseError {
            switch pErr {
            case .ineligibleForOffer, .invalidQuantity, .productUnavailable:
                return .ineligible
            default:
                throw RovenueError(kind: .storeProblem, message: "\(pErr)")
            }
        } catch {
            throw RovenueError(kind: .storeProblem, message: "\(error)")
        }

        switch result {
        case .userCancelled:
            return .userCancelled
        case .pending:
            return .pending
        case let .success(verification):
            guard case let .verified(transaction) = verification else {
                throw RovenueError(kind: .receiptInvalid, message: "StoreKit transaction could not be verified")
            }
            return .success(
                jws: verification.jwsRepresentation,
                transactionId: String(transaction.id),
                finish: { await transaction.finish() }
            )
        @unknown default:
            throw RovenueError(kind: .storeProblem, message: "Unexpected StoreKit result")
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
