//  Errors.swift — public Swift error surface for the Rovenue façade.
//
//  Wraps the UniFFI-generated `RovenueError` (which carries `(message: String)`
//  on every case and uses PascalCase) as a flat camelCase Swift enum. The
//  associated message is dropped from the public type but appears in
//  `errorDescription` so consumers can surface it to logs / UI.

import Foundation

public extension Rovenue {
    enum Error: Swift.Error, Equatable, Sendable, LocalizedError {
        case notConfigured
        case invalidApiKey
        case invalidArgument
        case serverError
        case networkUnavailable
        case timeout
        case rateLimited
        case storage
        case userNotFound
        case insufficientCredits
        case entitlementInactive
        case duplicatePurchase
        case receiptInvalid
        case internalError

        // Swift-origin purchase-flow errors. These never come from the Rust
        // core (so they are absent from `mapError`) — they describe StoreKit
        // outcomes surfaced by the SDK-driven purchase flow.
        case purchaseCancelled
        case purchasePending
        case productNotAvailable
        case storeProblem

        public var errorDescription: String? {
            switch self {
            case .notConfigured:
                return "Rovenue.configure() must be called before accessing Rovenue.shared"
            case .invalidApiKey:
                return "API key is missing or invalid"
            case .invalidArgument:
                return "An argument was invalid (e.g. an empty value)"
            case .serverError:
                return "Server returned an error"
            case .networkUnavailable:
                return "Network is unavailable"
            case .timeout:
                return "Request timed out"
            case .rateLimited:
                return "Rate limit exceeded"
            case .storage:
                return "Local storage error"
            case .userNotFound:
                return "User not found"
            case .insufficientCredits:
                return "Insufficient credits for this operation"
            case .entitlementInactive:
                return "Entitlement is inactive"
            case .duplicatePurchase:
                return "Purchase already recorded"
            case .receiptInvalid:
                return "Receipt could not be validated"
            case .internalError:
                return "Internal SDK error"
            case .purchaseCancelled:
                return "The purchase was cancelled by the user"
            case .purchasePending:
                return "The purchase is pending external action (e.g. Ask to Buy)"
            case .productNotAvailable:
                return "The requested product is not available from the store"
            case .storeProblem:
                return "An unexpected error occurred communicating with the store"
            }
        }
    }
}

/// Maps the UniFFI-generated `RovenueError` to the public `Rovenue.Error`.
/// Exhaustively switched: any future Rust-side variant addition causes a
/// compile error here, surfacing the gap at build time rather than runtime.
internal func mapError(_ generated: RovenueError) -> Rovenue.Error {
    switch generated {
    case .NotConfigured:        return .notConfigured
    case .InvalidApiKey:        return .invalidApiKey
    case .InvalidArgument:      return .invalidArgument
    case .ServerError:          return .serverError
    case .NetworkUnavailable:   return .networkUnavailable
    case .Timeout:              return .timeout
    case .RateLimited:          return .rateLimited
    case .Storage:              return .storage
    case .UserNotFound:         return .userNotFound
    case .InsufficientCredits:  return .insufficientCredits
    case .EntitlementInactive:  return .entitlementInactive
    case .DuplicatePurchase:    return .duplicatePurchase
    case .ReceiptInvalid:       return .receiptInvalid
    case .Internal:             return .internalError
    }
}
