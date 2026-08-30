// Mapping.swift — pure functions mapping between the Swift façade's public
// types (`packages/sdk-swift/Sources/Rovenue/{Types,Errors,Rovenue}.swift`)
// and the Pigeon-generated `Rv*` DTOs / enums in `Messages.g.swift` (Task 2).
//
// No I/O, no Flutter-channel plumbing here — HostApiImpl.swift and
// EventBridge.swift are the only callers. Kept side-effect free so
// HostApiImplTests.swift can exercise every mapper directly.

import Foundation
#if os(iOS)
  import Flutter
#elseif os(macOS)
  import FlutterMacOS
#else
  #error("Unsupported platform.")
#endif
import Rovenue

// MARK: - Error mapping
//
// Every failure surfaced to Dart becomes a `PigeonError` whose `code` is
// EXACTLY the UDL `ErrorKind` variant name (see
// `packages/core-rs/src/librovenue.udl`). Task 3's Dart mapper
// (`rovenue_flutter_platform_interface/lib/src/errors.dart`,
// `_kindByCode`) matches on these 24 strings verbatim — a mismatch here
// silently degrades that error to `RovenueErrorKind.unknown` on the Dart
// side.
//
// The switch below is intentionally exhaustive with NO `default:` case:
// if `core-rs` ever adds a new `ErrorKind` variant, this file fails to
// compile until the new case is added here, so the mapping can never
// silently drift from the UDL contract.
extension ErrorKind {
  var udlVariantName: String {
    switch self {
    case .networkUnavailable: return "NetworkUnavailable"
    case .timeout: return "Timeout"
    case .rateLimited: return "RateLimited"
    case .serverError: return "ServerError"
    case .invalidApiKey: return "InvalidApiKey"
    case .forbidden: return "Forbidden"
    case .notFound: return "NotFound"
    case .invalidRequest: return "InvalidRequest"
    case .conflict: return "Conflict"
    case .invalidArgument: return "InvalidArgument"
    case .insufficientCredits: return "InsufficientCredits"
    case .funnelTokenNotFound: return "FunnelTokenNotFound"
    case .funnelTokenExpired: return "FunnelTokenExpired"
    case .funnelTokenAlreadyClaimed: return "FunnelTokenAlreadyClaimed"
    case .purchaseCanceled: return "PurchaseCanceled"
    case .productNotAvailable: return "ProductNotAvailable"
    case .alreadyOwned: return "AlreadyOwned"
    case .paymentDeclined: return "PaymentDeclined"
    case .storeServiceUnavailable: return "StoreServiceUnavailable"
    case .ineligible: return "Ineligible"
    case .receiptInvalid: return "ReceiptInvalid"
    case .storeProblem: return "StoreProblem"
    case .storage: return "Storage"
    case .internal: return "Internal"
    }
  }
}

/// Converts any thrown error into the `PigeonError` shape every
/// `RovenueHostApi` method must throw (binding contract from the plan's
/// Global Constraints — see task-4-context.md).
func fail(_ error: Error) -> PigeonError {
  if let e = error as? RovenueError {
    return PigeonError(
      code: e.kind.udlVariantName,
      message: e.message,
      details: [
        "detail": e.message,
        "serverCode": (e.serverCode as Any?) ?? NSNull(),
        "httpStatus": (e.httpStatus as Any?) ?? NSNull(),
        "retryable": e.isRetryable,
      ] as [String: Any]
    )
  }
  return PigeonError(
    code: "Internal",
    message: String(describing: error),
    details: [
      "detail": String(describing: error),
      "retryable": false,
    ] as [String: Any]
  )
}

/// Used for store-API calls gated behind `#available(iOS 15.0, macOS 12.0,
/// *)` when the running OS is older — mirrors
/// `packages/sdk-rn/ios/RovenueModule.swift`'s `StoreProblemFallbackException`.
/// `"StoreProblem"` is a real `ErrorKind` UDL variant, so this decodes on
/// the Dart side exactly like a server-originated `StoreProblem` error.
func availabilityError(_ message: String) -> PigeonError {
  PigeonError(
    code: "StoreProblem",
    message: message,
    details: [
      "detail": message,
      "retryable": false,
    ] as [String: Any]
  )
}

// MARK: - Simple 1:1 struct/enum mappers

func mapUser(_ u: User) -> RvUser {
  RvUser(rovenueId: u.rovenueId, appUserId: u.appUserId)
}

func mapEntitlement(_ e: Entitlement) -> RvEntitlement {
  RvEntitlement(
    id: e.id,
    active: e.isActive,
    expiresAt: e.expiresIso,
    productId: e.productIdentifier
  )
}

func mapExperimentAssignment(_ a: ExperimentAssignment) -> RvExperimentAssignment {
  RvExperimentAssignment(
    experimentId: a.experimentId,
    key: a.key,
    variantId: a.variantId,
    variantName: a.variantName,
    valueJson: a.valueJson
  )
}

func mapPurchaseResult(_ r: PurchaseResult) -> RvPurchaseResult {
  RvPurchaseResult(
    entitlements: r.entitlements.map(mapEntitlement),
    virtualCurrencies: r.virtualCurrencies,
    productId: r.productId,
    storeTransactionId: r.storeTransactionId,
    isDeferred: r.isDeferred
  )
}

func mapFunnelClaim(_ r: FunnelClaimResult) -> RvFunnelClaim {
  RvFunnelClaim(subscriberId: r.subscriberId, funnelAnswersJson: r.funnelAnswersJson)
}

func mapChangeEvent(_ event: ChangeEvent) -> RvChangeEvent {
  let kind: RvChangeEventKind
  switch event {
  case .entitlementsChanged: kind = .entitlementsChanged
  case .identityChanged: kind = .identityChanged
  case .virtualCurrenciesChanged: kind = .virtualCurrenciesChanged
  case .remoteConfigChanged: kind = .remoteConfigChanged
  }
  return RvChangeEvent(kind: kind)
}

/// `LogEntry.level` is the façade's own `"off"|"error"|"warn"|"info"|
/// "debug"|"trace"` string (see `Rovenue.swift`'s `LogEntry`), not the FFI
/// `LogLevel` enum — the mapping here is string-keyed accordingly. Unknown
/// values fall back to `.warn`, matching `RovenueModule.swift`'s
/// `configure` default.
func mapLogLevel(fromString level: String) -> RvLogLevel {
  switch level {
  case "off": return .off
  case "error": return .error
  case "warn": return .warn
  case "info": return .info
  case "debug": return .debug
  case "trace": return .trace
  default: return .warn
  }
}

func mapLogRecord(_ entry: LogEntry) -> RvLogRecord {
  RvLogRecord(
    level: mapLogLevel(fromString: entry.level),
    message: entry.message,
    fields: entry.data ?? [:]
  )
}

/// Inbound: the Pigeon `RvLogLevel` selector passed to `configure()` →
/// the FFI `LogLevel` the façade's `Rovenue.configure` expects.
func mapLogLevel(_ level: RvLogLevel) -> LogLevel {
  switch level {
  case .off: return .off
  case .error: return .error
  case .warn: return .warn
  case .info: return .info
  case .debug: return .debug
  case .trace: return .trace
  }
}

/// Outbound: façade `ProductType` → `RvProductType`.
func mapProductType(_ t: ProductType) -> RvProductType {
  switch t {
  case .subscription: return .subscription
  case .consumable: return .consumable
  case .nonConsumable: return .nonConsumable
  }
}

/// Inbound: `RvProductType` (from `purchase()`'s `productType` argument) →
/// façade `ProductType`. Mirrors `RovenueModule.swift`'s `productType(from:)`.
func mapProductType(_ t: RvProductType) -> ProductType {
  switch t {
  case .subscription: return .subscription
  case .consumable: return .consumable
  case .nonConsumable: return .nonConsumable
  }
}

func mapSessionEventKind(_ k: RvSessionEventKind) -> SessionEventKind {
  switch k {
  case .open: return .open
  case .background: return .background
  case .close: return .close
  }
}

/// Inbound: `claimInstall`'s `RvClaimInstallParams` → façade
/// `ClaimInstallParams`. `platform`/`locale`/`timezone`/`screenDims` are
/// non-optional on the façade side; missing values default the same way
/// `RovenueModule.swift`'s Expo bridge does.
func mapClaimInstallParams(_ p: RvClaimInstallParams) -> ClaimInstallParams {
  ClaimInstallParams(
    platform: p.platform ?? "ios",
    locale: p.locale ?? "",
    timezone: p.timezone ?? "",
    screenDims: p.screenDims ?? "",
    deviceModel: p.deviceModel,
    installReferrer: p.installReferrer
  )
}

// MARK: - Store product graph (iOS 15 / macOS 12 StoreKit-backed types)

func mapProductCategory(_ c: ProductCategory) -> RvProductCategory {
  switch c {
  case .subscription: return .subscription
  case .nonSubscription: return .nonSubscription
  }
}

func mapPeriodUnit(_ u: PeriodUnit) -> RvPeriodUnit {
  switch u {
  case .day: return .day
  case .week: return .week
  case .month: return .month
  case .year: return .year
  }
}

func mapPaymentMode(_ m: PaymentMode) -> RvPaymentMode {
  switch m {
  case .freeTrial: return .freeTrial
  case .payAsYouGo: return .payAsYouGo
  case .payUpFront: return .payUpFront
  }
}

func mapDiscountType(_ t: DiscountType) -> RvDiscountType {
  switch t {
  case .introductory: return .introductory
  case .promotional: return .promotional
  case .winBack: return .winBack
  }
}

func mapRecurrenceMode(_ r: RecurrenceMode) -> RvRecurrenceMode {
  switch r {
  case .infiniteRecurring: return .infiniteRecurring
  case .finiteRecurring: return .finiteRecurring
  case .nonRecurring: return .nonRecurring
  }
}

func mapPackageType(_ t: PackageType) -> RvPackageType {
  switch t {
  case .unknown: return .unknown
  case .custom: return .custom
  case .lifetime: return .lifetime
  case .annual: return .annual
  case .sixMonth: return .sixMonth
  case .threeMonth: return .threeMonth
  case .twoMonth: return .twoMonth
  case .monthly: return .monthly
  case .weekly: return .weekly
  }
}

/// `Decimal?` → `Double?` for the Pigeon wire type — `NSDecimalNumber`
/// round-trip mirrors `RovenueModule.swift`'s `decimalOrNull`.
private func toDouble(_ d: Decimal?) -> Double? {
  d.map { NSDecimalNumber(decimal: $0).doubleValue }
}

func mapPeriod(_ p: Period) -> RvPeriod {
  RvPeriod(value: Int64(p.value), unit: mapPeriodUnit(p.unit), iso8601: p.iso8601)
}

func mapIntroPrice(_ i: IntroPrice) -> RvIntroPrice {
  RvIntroPrice(
    price: toDouble(i.price),
    priceString: i.priceString,
    currencyCode: i.currencyCode,
    period: mapPeriod(i.period),
    cycles: Int64(i.cycles),
    paymentMode: mapPaymentMode(i.paymentMode)
  )
}

func mapDiscount(_ d: Discount) -> RvDiscount {
  RvDiscount(
    identifier: d.identifier,
    price: toDouble(d.price),
    priceString: d.priceString,
    currencyCode: d.currencyCode,
    period: mapPeriod(d.period),
    numberOfPeriods: Int64(d.numberOfPeriods),
    paymentMode: mapPaymentMode(d.paymentMode),
    type: mapDiscountType(d.type)
  )
}

func mapPricingPhase(_ ph: PricingPhase) -> RvPricingPhase {
  RvPricingPhase(
    price: toDouble(ph.price),
    priceString: ph.priceString,
    currencyCode: ph.currencyCode,
    billingPeriod: mapPeriod(ph.billingPeriod),
    billingCycleCount: ph.billingCycleCount.map { Int64($0) },
    recurrenceMode: mapRecurrenceMode(ph.recurrenceMode),
    paymentMode: ph.paymentMode.map(mapPaymentMode)
  )
}

func mapSubscriptionOption(_ opt: SubscriptionOption) -> RvSubscriptionOption {
  RvSubscriptionOption(
    id: opt.id,
    basePlanId: opt.basePlanId,
    offerId: opt.offerId,
    tags: opt.tags,
    isBasePlan: opt.isBasePlan,
    isPrepaid: opt.isPrepaid,
    pricingPhases: opt.pricingPhases.map(mapPricingPhase),
    freePhase: opt.freePhase.map(mapPricingPhase),
    introPhase: opt.introPhase.map(mapPricingPhase),
    fullPricePhase: opt.fullPricePhase.map(mapPricingPhase)
  )
}

func mapStoreProduct(_ p: StoreProduct) -> RvStoreProduct {
  RvStoreProduct(
    id: p.id,
    type: mapProductType(p.type),
    productCategory: mapProductCategory(p.productCategory),
    displayName: p.displayName,
    description: p.description,
    priceString: p.priceString,
    price: toDouble(p.price),
    currencyCode: p.currencyCode,
    subscriptionPeriod: p.subscriptionPeriod.map(mapPeriod),
    subscriptionGroupIdentifier: p.subscriptionGroupIdentifier,
    isFamilyShareable: p.isFamilyShareable,
    introPrice: p.introPrice.map(mapIntroPrice),
    discounts: p.discounts.map(mapDiscount),
    isEligibleForIntroOffer: p.isEligibleForIntroOffer,
    // subscriptionOptions / defaultOption are Android-only (Google Play
    // base plans + offers) — iOS always emits nil for both, mirroring
    // RovenueModule.swift's dtoFromStoreProduct.
    subscriptionOptions: nil,
    defaultOption: nil,
    pricePerWeek: toDouble(p.pricePerWeek),
    pricePerMonth: toDouble(p.pricePerMonth),
    pricePerYear: toDouble(p.pricePerYear),
    pricePerWeekString: p.pricePerWeekString,
    pricePerMonthString: p.pricePerMonthString,
    pricePerYearString: p.pricePerYearString
  )
}

func mapPackage(_ pkg: Package) -> RvPackage {
  RvPackage(
    identifier: pkg.identifier,
    packageType: mapPackageType(pkg.packageType),
    product: mapStoreProduct(pkg.product)
  )
}

func mapOffering(_ off: Offering) -> RvOffering {
  RvOffering(
    identifier: off.identifier,
    isDefault: off.isDefault,
    packages: off.packages.map(mapPackage)
  )
}

func mapOfferings(_ o: Offerings) -> RvOfferings {
  RvOfferings(
    current: o.current?.identifier,
    offerings: o.all.values.map(mapOffering)
  )
}

func mapPresentedContext(_ c: PresentedContext) -> RvPresentedContext {
  RvPresentedContext(
    placementId: c.placementId,
    paywallId: c.paywallId,
    variantId: c.variantId,
    experimentKey: c.experimentKey,
    revision: c.revision
  )
}

func mapPaywall(_ p: Paywall) -> RvPaywall {
  // Re-serialize the already-decoded [String: Any] rather than
  // round-tripping the raw string — mirrors RovenueModule.swift's
  // dtoFromPaywall. Dart re-parses this JSON string itself.
  let remoteConfigJson: String? = p.remoteConfig.flatMap { dict -> String? in
    guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
    return String(data: data, encoding: .utf8)
  }
  return RvPaywall(
    placementIdentifier: p.placementIdentifier,
    placementRevision: p.placementRevision,
    paywallIdentifier: p.paywallIdentifier,
    paywallName: p.paywallName,
    configFormatVersion: p.configFormatVersion,
    remoteConfigJson: remoteConfigJson,
    remoteConfigLocale: p.remoteConfigLocale,
    builderConfigJson: p.builderConfigJson,
    offering: p.offering.map(mapOffering),
    presentedContext: p.presentedContext.map(mapPresentedContext),
    servedFromFallback: p.servedFromFallback
  )
}
