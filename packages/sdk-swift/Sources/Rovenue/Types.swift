//  Types.swift — Sendable conformance for UniFFI-generated value types.
//
//  The generated `User`, `Entitlement`, `ReceiptResult`, and `ChangeEvent`
//  already conform to `Equatable, Hashable` via UniFFI-generated extensions,
//  so we only need to add `@unchecked Sendable` here so SwiftUI / Combine
//  consumers can pass these values across actors.
//
//  All stored properties are themselves `Sendable` (String, Int64, Bool,
//  Optional<…>) — the `@unchecked` is purely because the structs are defined
//  in another file we don't own, so the compiler can't synthesize the
//  conformance automatically.
//
//  Adding these here keeps the public API surface idiomatic without forcing
//  the UDL to declare conformance traits (UniFFI 0.25 doesn't expose that
//  knob anyway).

import Foundation

extension User: @unchecked Sendable {}

extension Entitlement: @unchecked Sendable {}

extension ReceiptResult: @unchecked Sendable {}

extension ChangeEvent: @unchecked Sendable {}

// MARK: - Public purchase types
//
// These are the SDK's public-facing purchasing surface. They intentionally
// mirror the RevenueCat / Adapty shapes (Offerings → Offering → Package →
// StoreProduct) so the API is familiar.
//
// NOTE: the UniFFI core returns its own `CoreOfferings` / `CoreOffering` /
// `CoreOfferingProduct` value types (defined in Generated/RovenueFFI.swift,
// renamed from `Offerings` / `Offering` / `OfferingProduct` to avoid a
// same-module name collision with the public types below). `getOfferings()`
// in Rovenue.swift bridges the core types into these public ones, enriching
// them with StoreKit price metadata.

/// Product kind, mapped from the core's `productType` string.
public enum ProductType: Sendable, Equatable {
    case subscription, consumable, nonConsumable

    public static func from(_ raw: String) -> ProductType {
        switch raw {
        case "CONSUMABLE": return .consumable
        case "NON_CONSUMABLE": return .nonConsumable
        case "SUBSCRIPTION": return .subscription
        default: return .subscription
        }
    }
}

/// A purchasable product, enriched with StoreKit price metadata when available.
public struct StoreProduct: Sendable, Equatable {
    public let id: String
    public let type: ProductType
    public let displayName: String
    public let priceString: String?
    public let price: Decimal?
    public let currencyCode: String?

    public init(
        id: String,
        type: ProductType,
        displayName: String,
        priceString: String? = nil,
        price: Decimal? = nil,
        currencyCode: String? = nil
    ) {
        self.id = id
        self.type = type
        self.displayName = displayName
        self.priceString = priceString
        self.price = price
        self.currencyCode = currencyCode
    }
}

/// A named container pairing an offering identifier with a concrete product.
public struct Package: Sendable, Equatable {
    public let identifier: String
    public let product: StoreProduct

    public init(identifier: String, product: StoreProduct) {
        self.identifier = identifier
        self.product = product
    }
}

/// A group of packages presented together.
public struct Offering: Sendable, Equatable {
    public let identifier: String
    public let isDefault: Bool
    public let packages: [Package]

    public init(identifier: String, isDefault: Bool, packages: [Package]) {
        self.identifier = identifier
        self.isDefault = isDefault
        self.packages = packages
    }
}

/// The full set of offerings, plus the server-designated `current` offering.
public struct Offerings: Sendable, Equatable {
    public let current: Offering?
    public let all: [String: Offering]

    public init(current: Offering?, all: [String: Offering]) {
        self.current = current
        self.all = all
    }
}

/// The result of a completed purchase: refreshed entitlements + virtual-currency balances,
/// plus the product / store-transaction identifiers for the purchase that ran.
public struct PurchaseResult: Sendable, Equatable {
    public let entitlements: [Entitlement]
    public let virtualCurrencies: [String: Int64]
    public let productId: String
    public let storeTransactionId: String

    public init(
        entitlements: [Entitlement],
        virtualCurrencies: [String: Int64],
        productId: String,
        storeTransactionId: String
    ) {
        self.entitlements = entitlements
        self.virtualCurrencies = virtualCurrencies
        self.productId = productId
        self.storeTransactionId = storeTransactionId
    }
}
