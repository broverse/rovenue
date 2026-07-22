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
import StoreKit

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

public enum ProductCategory: Sendable, Equatable { case subscription, nonSubscription }
public enum PeriodUnit: Sendable, Equatable { case day, week, month, year }
public enum PaymentMode: Sendable, Equatable { case freeTrial, payAsYouGo, payUpFront }
public enum DiscountType: Sendable, Equatable { case introductory, promotional, winBack }
public enum RecurrenceMode: Sendable, Equatable { case infiniteRecurring, finiteRecurring, nonRecurring }

public struct Period: Sendable, Equatable {
    public let value: Int
    public let unit: PeriodUnit
    public let iso8601: String
    public init(value: Int, unit: PeriodUnit, iso8601: String) {
        self.value = value; self.unit = unit; self.iso8601 = iso8601
    }
}

public struct IntroPrice: Sendable, Equatable {
    public let price: Decimal?
    public let priceString: String?
    public let currencyCode: String?
    public let period: Period
    public let cycles: Int
    public let paymentMode: PaymentMode
    public init(price: Decimal?, priceString: String?, currencyCode: String?,
                period: Period, cycles: Int, paymentMode: PaymentMode) {
        self.price = price; self.priceString = priceString; self.currencyCode = currencyCode
        self.period = period; self.cycles = cycles; self.paymentMode = paymentMode
    }
}

public struct Discount: Sendable, Equatable {
    public let identifier: String?
    public let price: Decimal?
    public let priceString: String?
    public let currencyCode: String?
    public let period: Period
    public let numberOfPeriods: Int
    public let paymentMode: PaymentMode
    public let type: DiscountType
    public init(identifier: String?, price: Decimal?, priceString: String?, currencyCode: String?,
                period: Period, numberOfPeriods: Int, paymentMode: PaymentMode, type: DiscountType) {
        self.identifier = identifier; self.price = price; self.priceString = priceString
        self.currencyCode = currencyCode; self.period = period
        self.numberOfPeriods = numberOfPeriods; self.paymentMode = paymentMode; self.type = type
    }
}

public struct PricingPhase: Sendable, Equatable {
    public let price: Decimal?
    public let priceString: String?
    public let currencyCode: String?
    public let billingPeriod: Period
    public let billingCycleCount: Int?
    public let recurrenceMode: RecurrenceMode
    public let paymentMode: PaymentMode?
    public init(price: Decimal?, priceString: String?, currencyCode: String?,
                billingPeriod: Period, billingCycleCount: Int?,
                recurrenceMode: RecurrenceMode, paymentMode: PaymentMode?) {
        self.price = price; self.priceString = priceString; self.currencyCode = currencyCode
        self.billingPeriod = billingPeriod; self.billingCycleCount = billingCycleCount
        self.recurrenceMode = recurrenceMode; self.paymentMode = paymentMode
    }
}

public struct SubscriptionOption: Sendable, Equatable {
    public let id: String
    public let basePlanId: String?
    public let offerId: String?
    public let tags: [String]
    public let isBasePlan: Bool
    public let isPrepaid: Bool
    public let pricingPhases: [PricingPhase]
    public let freePhase: PricingPhase?
    public let introPhase: PricingPhase?
    public let fullPricePhase: PricingPhase?
    public init(id: String, basePlanId: String?, offerId: String?, tags: [String],
                isBasePlan: Bool, isPrepaid: Bool, pricingPhases: [PricingPhase],
                freePhase: PricingPhase?, introPhase: PricingPhase?, fullPricePhase: PricingPhase?) {
        self.id = id; self.basePlanId = basePlanId; self.offerId = offerId; self.tags = tags
        self.isBasePlan = isBasePlan; self.isPrepaid = isPrepaid; self.pricingPhases = pricingPhases
        self.freePhase = freePhase; self.introPhase = introPhase; self.fullPricePhase = fullPricePhase
    }
}

public enum PackageType: Sendable, Equatable {
    case unknown, custom, lifetime, annual, sixMonth, threeMonth, twoMonth, monthly, weekly
}

/// A purchasable product, enriched with StoreKit price metadata when available.
public struct StoreProduct: Sendable, Equatable {
    public let id: String
    public let type: ProductType
    public let productCategory: ProductCategory
    public let displayName: String
    public let description: String?
    public let priceString: String?
    public let price: Decimal?
    public let currencyCode: String?
    public let subscriptionPeriod: Period?
    public let subscriptionGroupIdentifier: String?
    public let isFamilyShareable: Bool
    public let introPrice: IntroPrice?
    public let discounts: [Discount]
    public let isEligibleForIntroOffer: Bool?
    public let subscriptionOptions: [SubscriptionOption]?
    public let defaultOption: SubscriptionOption?
    public let pricePerWeek: Decimal?
    public let pricePerMonth: Decimal?
    public let pricePerYear: Decimal?
    public let pricePerWeekString: String?
    public let pricePerMonthString: String?
    public let pricePerYearString: String?
    public let rawStoreProduct: StoreKit.Product?
    public init(id: String, type: ProductType, productCategory: ProductCategory,
                displayName: String, description: String?, priceString: String?, price: Decimal?,
                currencyCode: String?, subscriptionPeriod: Period?, subscriptionGroupIdentifier: String?,
                isFamilyShareable: Bool, introPrice: IntroPrice?, discounts: [Discount],
                isEligibleForIntroOffer: Bool?, subscriptionOptions: [SubscriptionOption]?,
                defaultOption: SubscriptionOption?, pricePerWeek: Decimal?, pricePerMonth: Decimal?,
                pricePerYear: Decimal?, pricePerWeekString: String?, pricePerMonthString: String?,
                pricePerYearString: String?, rawStoreProduct: StoreKit.Product?) {
        self.id = id; self.type = type; self.productCategory = productCategory
        self.displayName = displayName; self.description = description
        self.priceString = priceString; self.price = price; self.currencyCode = currencyCode
        self.subscriptionPeriod = subscriptionPeriod
        self.subscriptionGroupIdentifier = subscriptionGroupIdentifier
        self.isFamilyShareable = isFamilyShareable; self.introPrice = introPrice
        self.discounts = discounts; self.isEligibleForIntroOffer = isEligibleForIntroOffer
        self.subscriptionOptions = subscriptionOptions; self.defaultOption = defaultOption
        self.pricePerWeek = pricePerWeek; self.pricePerMonth = pricePerMonth
        self.pricePerYear = pricePerYear; self.pricePerWeekString = pricePerWeekString
        self.pricePerMonthString = pricePerMonthString; self.pricePerYearString = pricePerYearString
        self.rawStoreProduct = rawStoreProduct
    }
}

/// A named container pairing an offering identifier with a concrete product.
public struct Package: Sendable, Equatable {
    public let identifier: String
    public let packageType: PackageType
    public let product: StoreProduct

    public init(identifier: String, packageType: PackageType, product: StoreProduct) {
        self.identifier = identifier; self.packageType = packageType; self.product = product
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

extension Offering {
    public func package(identifier: String) -> Package? {
        packages.first { $0.identifier == identifier }
    }
    private func first(_ t: PackageType) -> Package? { packages.first { $0.packageType == t } }
    public var lifetime: Package? { first(.lifetime) }
    public var annual: Package? { first(.annual) }
    public var sixMonth: Package? { first(.sixMonth) }
    public var threeMonth: Package? { first(.threeMonth) }
    public var twoMonth: Package? { first(.twoMonth) }
    public var monthly: Package? { first(.monthly) }
    public var weekly: Package? { first(.weekly) }
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

// MARK: - Placements / Paywalls

/// Paywall-attribution snapshot for the paywall a `getPaywall(placementId:)`
/// call resolved. Round-tripped opaquely into `purchase()`'s attribution
/// path, and the source `logPaywallShown(_:)` builds its `paywall_view`
/// event from — mirrors the core's `CorePresentedContext`.
public struct PresentedContext: Sendable, Equatable {
    public let placementId: String
    public let paywallId: String
    public let variantId: String?
    public let experimentKey: String?
    public let revision: Int64

    public init(placementId: String, paywallId: String, variantId: String?, experimentKey: String?, revision: Int64) {
        self.placementId = placementId
        self.paywallId = paywallId
        self.variantId = variantId
        self.experimentKey = experimentKey
        self.revision = revision
    }
}

/// A resolved placement: either a direct paywall assignment or the winning
/// variant of a client-drawn PAYWALL experiment. The SDK ships no renderer
/// (Adapty remote-config model, Phase A) — callers read `remoteConfig` and
/// build their own UI, then call `logPaywallShown(_:)` once it's on screen.
public struct Paywall {
    public let placementIdentifier: String
    public let placementRevision: Int64
    public let paywallIdentifier: String?
    public let paywallName: String?
    public let configFormatVersion: Int64
    /// Decoded from the core's raw `remoteConfigJson` string via
    /// `JSONSerialization`. `nil` when the paywall has no remote config for
    /// the resolved locale, or when the JSON fails to decode as an object.
    public let remoteConfig: [String: Any]?
    public let remoteConfigLocale: String?
    /// Raw JSON of the Phase-B builder component tree (`configFormatVersion`
    /// 2 paywalls). Consumed by `RovenuePaywallView`; `nil` for
    /// remote-config-only paywalls.
    public let builderConfigJson: String?
    public let offering: Offering?
    public let presentedContext: PresentedContext?
    /// `true` only when this paywall was resolved from the bundled
    /// fallback-placements file (both network and disk cache missed) —
    /// see `Rovenue.setFallbackPlacements`. `false` otherwise. Defaulted so
    /// existing positional/named constructions keep compiling.
    public let servedFromFallback: Bool

    public init(
        placementIdentifier: String,
        placementRevision: Int64,
        paywallIdentifier: String?,
        paywallName: String?,
        configFormatVersion: Int64,
        remoteConfig: [String: Any]?,
        remoteConfigLocale: String?,
        builderConfigJson: String? = nil,
        offering: Offering?,
        presentedContext: PresentedContext?,
        servedFromFallback: Bool = false
    ) {
        self.placementIdentifier = placementIdentifier
        self.placementRevision = placementRevision
        self.paywallIdentifier = paywallIdentifier
        self.paywallName = paywallName
        self.configFormatVersion = configFormatVersion
        self.remoteConfig = remoteConfig
        self.remoteConfigLocale = remoteConfigLocale
        self.builderConfigJson = builderConfigJson
        self.offering = offering
        self.presentedContext = presentedContext
        self.servedFromFallback = servedFromFallback
    }
}

/// The result of a completed purchase: refreshed entitlements + virtual-currency balances,
/// plus the product / store-transaction identifiers for the purchase that ran.
///
/// `isDeferred` is `true` when the purchase is pending external approval
/// (e.g. Ask to Buy). In that case `entitlements` is empty and
/// `storeTransactionId` is an empty string — the entitlements will arrive
/// asynchronously once the approver accepts.
public struct PurchaseResult: Sendable, Equatable {
    public let entitlements: [Entitlement]
    public let virtualCurrencies: [String: Int64]
    public let productId: String
    public let storeTransactionId: String
    /// `true` when the purchase is deferred pending external approval.
    public var isDeferred: Bool

    public init(
        entitlements: [Entitlement],
        virtualCurrencies: [String: Int64],
        productId: String,
        storeTransactionId: String,
        isDeferred: Bool = false
    ) {
        self.entitlements = entitlements
        self.virtualCurrencies = virtualCurrencies
        self.productId = productId
        self.storeTransactionId = storeTransactionId
        self.isDeferred = isDeferred
    }
}
