// RovenueModule.swift — Expo Module bridge forwarding to the M3 Swift
// `Rovenue` singleton.
//
// Compile target: iOS 13+. Depends on:
//   - ExpoModulesCore (peer pod via Expo autolinking)
//   - Rovenue Swift module (pod :path injected by config plugin)
//
// JS surface mirrors RovenueModuleSpec in
// packages/sdk-rn/src/specs/RovenueModule.types.ts.

import ExpoModulesCore
import Rovenue
import UIKit

// Single Expo exception that wraps ANY RovenueError from the Swift façade.
//
// `code`   = String(describing: error.kind) — yields camelCase
//            (e.g. "networkUnavailable", "purchaseCanceled"). The JS
//            mapNativeError() normaliser resolves this back to the canonical
//            PascalCase ErrorKind.
// `reason` = a tagged JSON envelope carrying the human message AND the
//            structured extras (serverCode / httpStatus / retryable).
//
// WHY an envelope and not `userInfo`: the Expo JSI bridge forwards ONLY `code`
// and `message` to JS. `Exception.userInfo` is never read — the reject path
// (`callPromiseSetupWithBlock` → `makeCodedError(code, message)`) discards
// everything else. So the only way to get the extras across is to fold them
// into the message; the JS mapNativeError() unpacks them. The prefix is kept
// in sync verbatim with NATIVE_ERROR_ENVELOPE_PREFIX in src/errors.ts.
final class RovenueCodedError: Exception {
    private let _code: String
    private let _reason: String

    init(_ error: RovenueError) {
        _code   = String(describing: error.kind)
        _reason = Self.encodeEnvelope(error)
        super.init()
    }

    override var code: String { _code }
    override var reason: String { _reason }

    private static let envelopePrefix = "@rovenue/err1:"

    private static func encodeEnvelope(_ error: RovenueError) -> String {
        var env: [String: Any] = ["message": error.message, "retryable": error.isRetryable]
        if let sc = error.serverCode { env["serverCode"] = sc }
        if let hs = error.httpStatus { env["httpStatus"]  = hs }
        guard let data = try? JSONSerialization.data(withJSONObject: env),
              let json = String(data: data, encoding: .utf8) else {
            // Fall back to the plain message; JS treats a non-prefixed message verbatim.
            return error.message
        }
        return envelopePrefix + json
    }
}

// Minimal fallback for OS-version guards where we have no RovenueError yet.
// JS normalizer maps "storeProblem" → "StoreProblem".
private final class StoreProblemFallbackException: Exception {
    private let _reason: String
    init(_ reason: String) { _reason = reason; super.init() }
    override var code: String { "storeProblem" }
    override var reason: String { _reason }
}

// Helper: run `body`, converting any thrown RovenueError to RovenueCodedError
// so the Expo bridge surfaces a structured `code`/userInfo to JS.
// Non-RovenueError failures propagate unchanged.
private func rovenueCall<T>(_ body: () async throws -> T) async throws -> T {
    do { return try await body() }
    catch let e as RovenueError { throw RovenueCodedError(e) }
}

// Sync variant for configure (called from a non-async closure).
private func rovenueCallSync<T>(_ body: () throws -> T) throws -> T {
    do { return try body() }
    catch let e as RovenueError { throw RovenueCodedError(e) }
}

public class RovenueModule: Module {
    private var changesTask: Task<Void, Never>?
    private var funnelClaimsTask: Task<Void, Never>?
    private var logUnsubscribe: (() -> Void)?

    public func definition() -> ModuleDefinition {
        Name("Rovenue")

        // ---------------- Sync ----------------
        //
        // appVersion is optional from JS — when nil/omitted, the Swift
        // façade falls back to Bundle.main.infoDictionary[CFBundleShortVersionString].
        // For Expo apps that's the value baked from app.json's `expo.version`
        // at prebuild time; for bare RN it's the host project's plist.
        Function("configure") { (apiKey: String, baseUrl: String?, logLevel: String, appVersion: String?, environment: String?) in
            let level: LogLevel = {
                switch logLevel {
                case "off":   return .off
                case "error": return .error
                case "warn":  return .warn
                case "info":  return .info
                case "debug": return .debug
                case "trace": return .trace
                default:      return .warn
                }
            }()
            try rovenueCallSync {
                try Rovenue.configure(
                    apiKey: apiKey,
                    baseUrl: baseUrl,
                    logLevel: level,
                    appVersion: appVersion,
                    environment: environment
                )
            }
        }
        Function("shutdown") { Rovenue.shared.shutdown() }
        Function("setForeground") { (foreground: Bool) in
            Rovenue.shared.setForeground(foreground)
        }
        Function("getVersion") { () -> String in Rovenue.shared.version }

        // ---------------- Async ----------------
        AsyncFunction("currentUser") { () -> [String: Any?] in
            let u = await Rovenue.shared.currentUser()
            return ["rovenueId": u.rovenueId, "appUserId": u.appUserId as Any?]
        }
        AsyncFunction("identify") { (appUserId: String) in
            try await rovenueCall { try await Rovenue.shared.identify(appUserId) }
        }
        AsyncFunction("logOut") {
            try await rovenueCall { try await Rovenue.shared.logOut() }
        }
        AsyncFunction("entitlement") { (id: String) -> [String: Any?]? in
            guard let e = await Rovenue.shared.entitlement(id) else { return nil }
            return Self.dtoFromEntitlement(e)
        }
        AsyncFunction("entitlementsAll") { () -> [[String: Any?]] in
            await Rovenue.shared.entitlementsAll().map(Self.dtoFromEntitlement)
        }
        AsyncFunction("refreshEntitlements") {
            try await rovenueCall { try await Rovenue.shared.refreshEntitlements() }
        }
        AsyncFunction("virtualCurrencies") { () -> [String: Double] in
            // Long → Double is lossless up to 2^53.
            await Rovenue.shared.virtualCurrencyBalances().mapValues { Double($0) }
        }
        AsyncFunction("virtualCurrency") { (code: String) -> Double in
            Double(await Rovenue.shared.virtualCurrency(code))
        }
        AsyncFunction("refreshVirtualCurrencies") {
            try await rovenueCall { try await Rovenue.shared.refreshVirtualCurrencies() }
        }
        // ---------------- Remote Config ----------------
        AsyncFunction("refreshRemoteConfig") {
            try await rovenueCall { try await Rovenue.shared.refreshRemoteConfig() }
        }
        AsyncFunction("remoteConfigBool") { (key: String, fallback: Bool) -> Bool in
            await Rovenue.shared.remoteConfigBool(key, default: fallback)
        }
        AsyncFunction("remoteConfigString") { (key: String, fallback: String) -> String in
            await Rovenue.shared.remoteConfigString(key, default: fallback)
        }
        AsyncFunction("remoteConfigInt") { (key: String, fallback: Double) -> Double in
            // JS marshals numbers as Double; widen the façade's Int64 back to Double.
            Double(await Rovenue.shared.remoteConfigInt(key, default: Int64(fallback)))
        }
        AsyncFunction("remoteConfigDouble") { (key: String, fallback: Double) -> Double in
            await Rovenue.shared.remoteConfigDouble(key, default: fallback)
        }
        AsyncFunction("remoteConfigJson") { (key: String) -> String? in
            await Rovenue.shared.remoteConfigJSON(key)
        }
        AsyncFunction("remoteConfigKeys") { () -> [String] in
            await Rovenue.shared.remoteConfigKeys()
        }
        AsyncFunction("remoteConfigAllJson") { () -> String in
            await Rovenue.shared.remoteConfigAllJSON()
        }
        AsyncFunction("experiment") { (key: String) -> [String: Any?]? in
            guard let a = await Rovenue.shared.experiment(key) else { return nil }
            return Self.dtoFromExperimentAssignment(a)
        }
        AsyncFunction("experimentsAll") { () -> [[String: Any?]] in
            await Rovenue.shared.experimentsAll().map(Self.dtoFromExperimentAssignment)
        }

        // ---------------- Purchases ----------------
        //
        // StoreKit-backed, so gated on iOS 15 / macOS 12 to mirror the
        // Swift façade's `@available`. On older OS versions these reject
        // with a `StoreProblem` coded error rather than crashing.
        AsyncFunction("getOfferings") { () -> [String: Any] in
            guard #available(iOS 15.0, macOS 12.0, *) else {
                throw StoreProblemFallbackException("Offerings require iOS 15 / macOS 12 or newer")
            }
            do {
                let o = try await Rovenue.shared.getOfferings()
                return Self.dtoFromOfferings(o)
            } catch let e as RovenueError {
                throw RovenueCodedError(e)
            }
        }
        AsyncFunction("getPaywall") { (placementId: String, locale: String?) -> [String: Any?]? in
            guard #available(iOS 15.0, macOS 12.0, *) else {
                throw StoreProblemFallbackException("Placements require iOS 15 / macOS 12 or newer")
            }
            do {
                guard let p = try await Rovenue.shared.getPaywall(placementId: placementId, locale: locale) else {
                    return nil
                }
                return Self.dtoFromPaywall(p)
            } catch let e as RovenueError {
                throw RovenueCodedError(e)
            }
        }
        AsyncFunction("purchase") { (productId: String, productType: String, promotionalOfferId: String?, basePlanId: String?, offerId: String?) -> [String: Any?] in
            // basePlanId/offerId select a Play subscription offer on Android; ignored on iOS.
            guard #available(iOS 15.0, macOS 12.0, *) else {
                throw StoreProblemFallbackException("Purchases require iOS 15 / macOS 12 or newer")
            }
            // JS sends the lowercase DTO string; reconstruct the façade
            // enum. The façade re-resolves the real StoreKit product by
            // id, so displayName/price are not needed here.
            let product = StoreProduct(
                id: productId,
                type: Self.productType(from: productType),
                displayName: ""
            )
            do {
                let r: PurchaseResult
                if let offerId = promotionalOfferId {
                    // Task 4 added a public id-based overload that takes the
                    // offer identifier directly — no need to construct a Discount.
                    r = try await Rovenue.shared.purchase(product, promotionalOfferId: offerId)
                } else {
                    r = try await Rovenue.shared.purchase(product)
                }
                return Self.dtoFromPurchaseResult(r)
            } catch let e as RovenueError {
                throw RovenueCodedError(e)
            }
        }
        AsyncFunction("restorePurchases") { () -> [String: Any?] in
            guard #available(iOS 15.0, macOS 12.0, *) else {
                throw StoreProblemFallbackException("Restore requires iOS 15 / macOS 12 or newer")
            }
            do {
                let r = try await Rovenue.shared.restorePurchases()
                return Self.dtoFromPurchaseResult(r)
            } catch let e as RovenueError {
                throw RovenueCodedError(e)
            }
        }

        // ---------------- Refund Shield ----------------
        AsyncFunction("getAppAccountToken") { () -> String in
            try await rovenueCall { try await Rovenue.shared.getAppAccountToken() }
        }
        AsyncFunction("recordSessionEvent") { (kind: String, occurredAt: String, durationMs: Double?) -> Void in
            let kindEnum: SessionEventKind = {
                switch kind {
                case "open": return .open
                case "background": return .background
                case "close": return .close
                default: return .open
                }
            }()
            try await rovenueCall {
                try await Rovenue.shared.recordSessionEvent(
                    kind: kindEnum,
                    occurredAt: occurredAt,
                    durationMs: durationMs.map { UInt32($0) }
                )
            }
        }
        AsyncFunction("flushSessionEvents") { () -> Double in
            let n = try await rovenueCall { try await Rovenue.shared.flushSessionEvents() }
            return Double(n)
        }
        AsyncFunction("track") { (envelopeJson: String) in
            try await rovenueCall { try await Rovenue.shared.track(envelopeJson: envelopeJson) }
        }

        // ---------------- Funnel Claim ----------------
        AsyncFunction("installId") { () -> String in
            Rovenue.shared.installId()
        }
        AsyncFunction("hasResolvedFunnelClaim") { () -> Bool in
            Rovenue.shared.hasResolvedFunnelClaim()
        }
        AsyncFunction("claimFunnelToken") { (token: String) -> [String: Any?] in
            let r = try await rovenueCall { try await Rovenue.shared.claimFunnelToken(token) }
            return ["subscriberId": r.subscriberId, "funnelAnswersJson": r.funnelAnswersJson]
        }
        AsyncFunction("claimFromClipboard") { () -> [String: Any?]? in
            let marker = "rovenue-funnel:"
            let raw: String? = await MainActor.run { UIPasteboard.general.string }
            guard let s = raw, s.hasPrefix(marker) else { return nil }
            let token = String(s.dropFirst(marker.count))
            guard !token.isEmpty else { return nil }
            let r = try await rovenueCall { try await Rovenue.shared.claimFunnelToken(token) }
            // Clear only our own marked content so it isn't re-claimed/leaked.
            await MainActor.run {
                if UIPasteboard.general.string?.hasPrefix(marker) == true {
                    UIPasteboard.general.string = ""
                }
            }
            return ["subscriberId": r.subscriberId, "funnelAnswersJson": r.funnelAnswersJson]
        }
        AsyncFunction("claimInstall") { (params: [String: Any?]) -> [String: Any?]? in
            let p = ClaimInstallParams(
                platform: params["platform"] as? String ?? "ios",
                locale: params["locale"] as? String ?? "",
                timezone: params["timezone"] as? String ?? "",
                screenDims: params["screenDims"] as? String ?? "",
                deviceModel: params["deviceModel"] as? String,
                installReferrer: params["installReferrer"] as? String
            )
            guard let r = try await rovenueCall({ try await Rovenue.shared.claimInstall(p) }) else { return nil }
            return ["subscriberId": r.subscriberId, "funnelAnswersJson": r.funnelAnswersJson]
        }
        AsyncFunction("claimViaEmail") { (email: String) in
            try await rovenueCall { try await Rovenue.shared.claimViaEmail(email) }
        }

        // ---------------- Subscriber Attributes ----------------
        AsyncFunction("setAttributes") { (attributes: [String: String?]) in
            try await rovenueCall { try await Rovenue.shared.setAttributes(attributes) }
        }
        AsyncFunction("setEmail") { (email: String?) in
            try await rovenueCall { try await Rovenue.shared.setEmail(email) }
        }
        AsyncFunction("setDisplayName") { (name: String?) in
            try await rovenueCall { try await Rovenue.shared.setDisplayName(name) }
        }
        AsyncFunction("setPhoneNumber") { (phone: String?) in
            try await rovenueCall { try await Rovenue.shared.setPhoneNumber(phone) }
        }
        AsyncFunction("setPushToken") { (token: String?) in
            try await rovenueCall { try await Rovenue.shared.setPushToken(token) }
        }
        AsyncFunction("flushAttributes") { () -> Double in
            // UInt32 → Double for the JS number bridge (lossless).
            let n = try await rovenueCall { try await Rovenue.shared.flushAttributes() }
            return Double(n)
        }

        // ---------------- Events ----------------
        Events("onChange", "onLog", "onFunnelClaimResolved")

        OnStartObserving {
            self.changesTask = Task { [weak self] in
                for await event in Rovenue.shared.changes {
                    self?.sendEvent("onChange", ["event": Self.eventName(event)])
                }
            }
            self.funnelClaimsTask = Task { [weak self] in
                for await r in Rovenue.shared.funnelClaims {
                    self?.sendEvent("onFunnelClaimResolved", [
                        "subscriberId": r.subscriberId,
                        "funnelAnswersJson": r.funnelAnswersJson,
                    ])
                }
            }
            self.logUnsubscribe = Rovenue.shared.setLogHandler { [weak self] entry in
                self?.sendEvent("onLog", [
                    "level": entry.level,
                    "message": entry.message,
                    "data": entry.data as Any?,
                ])
            }
        }
        OnStopObserving {
            self.changesTask?.cancel()
            self.changesTask = nil
            self.funnelClaimsTask?.cancel()
            self.funnelClaimsTask = nil
            self.logUnsubscribe?()
            self.logUnsubscribe = nil
        }
    }

    private static func dtoFromEntitlement(_ e: Entitlement) -> [String: Any?] {
        [
            "id": e.id,
            "active": e.isActive,
            "expiresAt": e.expiresIso as Any?,
            "productId": e.productIdentifier,
        ]
    }

    private static func dtoFromExperimentAssignment(_ a: ExperimentAssignment) -> [String: Any?] {
        [
            "experimentId": a.experimentId,
            "key": a.key,
            "variantId": a.variantId,
            "variantName": a.variantName,
            "valueJson": a.valueJson,
        ]
    }

    // ---------------- Purchase DTO encoders ----------------

    /// Façade `ProductType` enum → lowercase DTO string (OUTBOUND).
    private static func productTypeString(_ t: ProductType) -> String {
        switch t {
        case .subscription:   return "subscription"
        case .consumable:     return "consumable"
        case .nonConsumable:  return "non_consumable"
        }
    }

    /// Lowercase DTO string → façade `ProductType` enum (INBOUND).
    /// Unknown values default to `.subscription` (mirrors the core's
    /// safest-assumption behaviour for product types).
    private static func productType(from raw: String) -> ProductType {
        switch raw {
        case "consumable":      return .consumable
        case "non_consumable":  return .nonConsumable
        default:                return .subscription
        }
    }

    // MARK: - Enum → string mappers

    @available(iOS 15.0, macOS 12.0, *)
    private static func productCategoryString(_ c: ProductCategory) -> String {
        switch c {
        case .subscription:    return "subscription"
        case .nonSubscription: return "nonSubscription"
        }
    }

    @available(iOS 15.0, macOS 12.0, *)
    private static func periodUnitString(_ u: PeriodUnit) -> String {
        switch u {
        case .day:   return "day"
        case .week:  return "week"
        case .month: return "month"
        case .year:  return "year"
        }
    }

    @available(iOS 15.0, macOS 12.0, *)
    private static func paymentModeString(_ m: PaymentMode) -> String {
        switch m {
        case .freeTrial:  return "freeTrial"
        case .payAsYouGo: return "payAsYouGo"
        case .payUpFront: return "payUpFront"
        }
    }

    @available(iOS 15.0, macOS 12.0, *)
    private static func discountTypeString(_ t: DiscountType) -> String {
        switch t {
        case .introductory: return "introductory"
        case .promotional:  return "promotional"
        case .winBack:      return "winBack"
        }
    }

    @available(iOS 15.0, macOS 12.0, *)
    private static func recurrenceModeString(_ r: RecurrenceMode) -> String {
        switch r {
        case .infiniteRecurring: return "infiniteRecurring"
        case .finiteRecurring:   return "finiteRecurring"
        case .nonRecurring:      return "nonRecurring"
        }
    }

    @available(iOS 15.0, macOS 12.0, *)
    private static func packageTypeString(_ t: PackageType) -> String {
        switch t {
        case .unknown:    return "unknown"
        case .custom:     return "custom"
        case .lifetime:   return "lifetime"
        case .annual:     return "annual"
        case .sixMonth:   return "sixMonth"
        case .threeMonth: return "threeMonth"
        case .twoMonth:   return "twoMonth"
        case .monthly:    return "monthly"
        case .weekly:     return "weekly"
        }
    }

    // MARK: - Nested DTO helpers

    /// Maps `Period` to `PeriodDTO` dict: { value, unit, iso8601 }.
    @available(iOS 15.0, macOS 12.0, *)
    private static func periodDict(_ p: Period) -> [String: Any] {
        [
            "value":   p.value,
            "unit":    periodUnitString(p.unit),
            "iso8601": p.iso8601,
        ]
    }

    /// Maps optional `IntroPrice` → `IntroPriceDTO` dict or `NSNull`.
    @available(iOS 15.0, macOS 12.0, *)
    private static func introDict(_ i: IntroPrice?) -> Any {
        guard let i else { return NSNull() }
        return [
            "price":        i.price.map { NSDecimalNumber(decimal: $0).doubleValue } as Any,
            "priceString":  i.priceString as Any,
            "currencyCode": i.currencyCode as Any,
            "period":       periodDict(i.period),
            "cycles":       i.cycles,
            "paymentMode":  paymentModeString(i.paymentMode),
        ] as [String: Any]
    }

    /// Maps `Discount` → `DiscountDTO` dict.
    @available(iOS 15.0, macOS 12.0, *)
    private static func discountDict(_ d: Discount) -> [String: Any] {
        [
            "identifier":      d.identifier as Any,
            "price":           d.price.map { NSDecimalNumber(decimal: $0).doubleValue } as Any,
            "priceString":     d.priceString as Any,
            "currencyCode":    d.currencyCode as Any,
            "period":          periodDict(d.period),
            "numberOfPeriods": d.numberOfPeriods,
            "paymentMode":     paymentModeString(d.paymentMode),
            "type":            discountTypeString(d.type),
        ]
    }

    /// Maps `PricingPhase` → `PricingPhaseDTO` dict.
    @available(iOS 15.0, macOS 12.0, *)
    private static func phaseDict(_ ph: PricingPhase) -> [String: Any] {
        [
            "price":             ph.price.map { NSDecimalNumber(decimal: $0).doubleValue } as Any,
            "priceString":       ph.priceString as Any,
            "currencyCode":      ph.currencyCode as Any,
            "billingPeriod":     periodDict(ph.billingPeriod),
            "billingCycleCount": ph.billingCycleCount as Any,
            "recurrenceMode":    recurrenceModeString(ph.recurrenceMode),
            "paymentMode":       ph.paymentMode.map { paymentModeString($0) } as Any,
        ]
    }

    /// Maps optional `PricingPhase` → `PricingPhaseDTO` dict or `NSNull`.
    @available(iOS 15.0, macOS 12.0, *)
    private static func optionalPhaseDict(_ ph: PricingPhase?) -> Any {
        guard let ph else { return NSNull() }
        return phaseDict(ph)
    }

    /// Maps `SubscriptionOption` → `SubscriptionOptionDTO` dict.
    @available(iOS 15.0, macOS 12.0, *)
    private static func optionDict(_ opt: SubscriptionOption) -> [String: Any] {
        [
            "id":              opt.id,
            "basePlanId":      opt.basePlanId as Any,
            "offerId":         opt.offerId as Any,
            "tags":            opt.tags,
            "isBasePlan":      opt.isBasePlan,
            "isPrepaid":       opt.isPrepaid,
            "pricingPhases":   opt.pricingPhases.map { phaseDict($0) },
            "freePhase":       optionalPhaseDict(opt.freePhase),
            "introPhase":      optionalPhaseDict(opt.introPhase),
            "fullPricePhase":  optionalPhaseDict(opt.fullPricePhase),
        ]
    }

    // MARK: - Top-level product DTO

    @available(iOS 15.0, macOS 12.0, *)
    private static func dtoFromStoreProduct(_ p: StoreProduct) -> [String: Any] {
        // Helper: Decimal? → Double or NSNull (for the JS number bridge).
        func decimalOrNull(_ d: Decimal?) -> Any {
            d.map { NSDecimalNumber(decimal: $0).doubleValue } as Any
        }
        return [
            "id":                         p.id,
            "type":                       productTypeString(p.type),
            "productCategory":            productCategoryString(p.productCategory),
            "displayName":                p.displayName,
            "description":                p.description as Any,
            "priceString":                p.priceString as Any,
            "price":                      decimalOrNull(p.price),
            "currencyCode":               p.currencyCode as Any,
            "subscriptionPeriod":         p.subscriptionPeriod.map { periodDict($0) } as Any,
            "subscriptionGroupIdentifier": p.subscriptionGroupIdentifier as Any,
            "isFamilyShareable":          p.isFamilyShareable,
            "introPrice":                 introDict(p.introPrice),
            "discounts":                  p.discounts.map { discountDict($0) },
            "isEligibleForIntroOffer":    p.isEligibleForIntroOffer as Any,
            // subscriptionOptions / defaultOption are Android-only (Google Play
            // base plans + offers). iOS always emits NSNull for both.
            "subscriptionOptions":        NSNull(),
            "defaultOption":              NSNull(),
            "pricePerWeek":               decimalOrNull(p.pricePerWeek),
            "pricePerMonth":              decimalOrNull(p.pricePerMonth),
            "pricePerYear":               decimalOrNull(p.pricePerYear),
            "pricePerWeekString":         p.pricePerWeekString as Any,
            "pricePerMonthString":        p.pricePerMonthString as Any,
            "pricePerYearString":         p.pricePerYearString as Any,
        ]
    }

    @available(iOS 15.0, macOS 12.0, *)
    private static func dtoFromOffering(_ off: Offering) -> [String: Any] {
        [
            "identifier": off.identifier,
            "isDefault": off.isDefault,
            "packages": off.packages.map { pkg in
                [
                    "identifier":  pkg.identifier,
                    "packageType": packageTypeString(pkg.packageType),
                    "product":     dtoFromStoreProduct(pkg.product),
                ] as [String: Any]
            },
        ]
    }

    @available(iOS 15.0, macOS 12.0, *)
    private static func dtoFromOfferings(_ o: Offerings) -> [String: Any] {
        let offerings: [[String: Any]] = o.all.values.map(dtoFromOffering)
        return [
            "current": o.current?.identifier as Any,
            "offerings": offerings,
        ]
    }

    @available(iOS 15.0, macOS 12.0, *)
    private static func dtoFromPresentedContext(_ c: PresentedContext) -> [String: Any?] {
        [
            "placementId": c.placementId,
            "paywallId": c.paywallId,
            "variantId": c.variantId,
            "experimentKey": c.experimentKey,
            "revision": c.revision,
        ]
    }

    @available(iOS 15.0, macOS 12.0, *)
    private static func dtoFromPaywall(_ p: Paywall) -> [String: Any?] {
        [
            "placementIdentifier": p.placementIdentifier,
            "placementRevision": p.placementRevision,
            "paywallIdentifier": p.paywallIdentifier,
            "paywallName": p.paywallName,
            "configFormatVersion": p.configFormatVersion,
            // Re-serialize the already-decoded [String: Any] rather than
            // round-tripping the raw string — Paywall's decode already
            // handled the nil-safety; JS re-parses this JSON string itself
            // (see paywalls.ts parseRemoteConfig), matching remoteConfigJson
            // key across all three façades' DTOs.
            "remoteConfigJson": p.remoteConfig.flatMap { dict -> String? in
                guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
                return String(data: data, encoding: .utf8)
            },
            "remoteConfigLocale": p.remoteConfigLocale,
            "offering": p.offering.map(dtoFromOffering),
            "presentedContext": p.presentedContext.map(dtoFromPresentedContext),
        ]
    }

    private static func dtoFromPurchaseResult(_ r: PurchaseResult) -> [String: Any?] {
        [
            "entitlements": r.entitlements.map(dtoFromEntitlement),
            "virtualCurrencies": r.virtualCurrencies.mapValues { Double($0) },
            "productId": r.productId,
            "storeTransactionId": r.storeTransactionId,
            "isDeferred": r.isDeferred,
        ]
    }
    private static func eventName(_ event: ChangeEvent) -> String {
        switch event {
        case .entitlementsChanged: return "ENTITLEMENTS_CHANGED"
        case .identityChanged:     return "IDENTITY_CHANGED"
        case .virtualCurrenciesChanged: return "VIRTUAL_CURRENCIES_CHANGED"
        case .remoteConfigChanged: return "REMOTE_CONFIG_CHANGED"
        }
    }
}
