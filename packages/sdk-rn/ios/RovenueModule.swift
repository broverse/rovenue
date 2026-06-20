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

// Expo coded exceptions for the StoreKit purchase flow. The `code` of each
// surfaces to JS unchanged and is matched by `mapNativeError` in
// packages/sdk-rn/src/errors.ts.
final class PurchaseCancelledException: Exception {
    private let _reason: String
    init(_ reason: String) { _reason = reason; super.init() }
    override var code: String { "PurchaseCancelled" }
    override var reason: String { _reason }
}
final class PurchasePendingException: Exception {
    private let _reason: String
    init(_ reason: String) { _reason = reason; super.init() }
    override var code: String { "PurchasePending" }
    override var reason: String { _reason }
}
final class ProductNotAvailableException: Exception {
    private let _reason: String
    init(_ reason: String) { _reason = reason; super.init() }
    override var code: String { "ProductNotAvailable" }
    override var reason: String { _reason }
}
final class StoreProblemException: Exception {
    private let _reason: String
    init(_ reason: String) { _reason = reason; super.init() }
    override var code: String { "StoreProblem" }
    override var reason: String { _reason }
}

public class RovenueModule: Module {
    private var changesTask: Task<Void, Never>?
    private var logUnsubscribe: (() -> Void)?

    public func definition() -> ModuleDefinition {
        Name("Rovenue")

        // ---------------- Sync ----------------
        //
        // appVersion is optional from JS — when nil/omitted, the Swift
        // façade falls back to Bundle.main.infoDictionary[CFBundleShortVersionString].
        // For Expo apps that's the value baked from app.json's `expo.version`
        // at prebuild time; for bare RN it's the host project's plist.
        Function("configure") { (apiKey: String, baseUrl: String?, debug: Bool, appVersion: String?, environment: String?) in
            try Rovenue.configure(
                apiKey: apiKey,
                baseUrl: baseUrl,
                debug: debug,
                appVersion: appVersion,
                environment: environment
            )
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
            try await Rovenue.shared.identify(appUserId)
        }
        AsyncFunction("logOut") {
            try await Rovenue.shared.logOut()
        }
        AsyncFunction("entitlement") { (id: String) -> [String: Any?]? in
            guard let e = await Rovenue.shared.entitlement(id) else { return nil }
            return Self.dtoFromEntitlement(e)
        }
        AsyncFunction("entitlementsAll") { () -> [[String: Any?]] in
            await Rovenue.shared.entitlementsAll().map(Self.dtoFromEntitlement)
        }
        AsyncFunction("refreshEntitlements") {
            try await Rovenue.shared.refreshEntitlements()
        }
        AsyncFunction("virtualCurrencies") { () -> [String: Double] in
            // Long → Double is lossless up to 2^53.
            await Rovenue.shared.virtualCurrencyBalances().mapValues { Double($0) }
        }
        AsyncFunction("virtualCurrency") { (code: String) -> Double in
            Double(await Rovenue.shared.virtualCurrency(code))
        }
        AsyncFunction("refreshVirtualCurrencies") { try await Rovenue.shared.refreshVirtualCurrencies() }
        // ---------------- Remote Config ----------------
        AsyncFunction("refreshRemoteConfig") { try await Rovenue.shared.refreshRemoteConfig() }
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
                throw StoreProblemException("Offerings require iOS 15 / macOS 12 or newer")
            }
            do {
                let o = try await Rovenue.shared.getOfferings()
                return Self.dtoFromOfferings(o)
            } catch let e as Rovenue.Error {
                throw Self.codedError(for: e)
            }
        }
        AsyncFunction("purchase") { (productId: String, productType: String) -> [String: Any?] in
            guard #available(iOS 15.0, macOS 12.0, *) else {
                throw StoreProblemException("Purchases require iOS 15 / macOS 12 or newer")
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
                let r = try await Rovenue.shared.purchase(product)
                return Self.dtoFromPurchaseResult(r)
            } catch let e as Rovenue.Error {
                throw Self.codedError(for: e)
            }
        }
        AsyncFunction("restorePurchases") { () -> [String: Any?] in
            guard #available(iOS 15.0, macOS 12.0, *) else {
                throw StoreProblemException("Restore requires iOS 15 / macOS 12 or newer")
            }
            do {
                let r = try await Rovenue.shared.restorePurchases()
                return Self.dtoFromPurchaseResult(r)
            } catch let e as Rovenue.Error {
                throw Self.codedError(for: e)
            }
        }

        // ---------------- Refund Shield ----------------
        AsyncFunction("getAppAccountToken") { () -> String in
            try await Rovenue.shared.getAppAccountToken()
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
            try await Rovenue.shared.recordSessionEvent(
                kind: kindEnum,
                occurredAt: occurredAt,
                durationMs: durationMs.map { UInt32($0) }
            )
        }
        AsyncFunction("flushSessionEvents") { () -> Double in
            let n = try await Rovenue.shared.flushSessionEvents()
            return Double(n)
        }
        AsyncFunction("track") { (envelopeJson: String) in
            try await Rovenue.shared.track(envelopeJson: envelopeJson)
        }

        // ---------------- Subscriber Attributes ----------------
        AsyncFunction("setAttributes") { (attributes: [String: String?]) in
            try await Rovenue.shared.setAttributes(attributes)
        }
        AsyncFunction("setEmail") { (email: String?) in
            try await Rovenue.shared.setEmail(email)
        }
        AsyncFunction("setDisplayName") { (name: String?) in
            try await Rovenue.shared.setDisplayName(name)
        }
        AsyncFunction("setPhoneNumber") { (phone: String?) in
            try await Rovenue.shared.setPhoneNumber(phone)
        }
        AsyncFunction("setPushToken") { (token: String?) in
            try await Rovenue.shared.setPushToken(token)
        }
        AsyncFunction("flushAttributes") { () -> Double in
            // UInt32 → Double for the JS number bridge (lossless).
            Double(try await Rovenue.shared.flushAttributes())
        }

        // ---------------- Events ----------------
        Events("onChange", "onLog")

        OnStartObserving {
            self.changesTask = Task { [weak self] in
                for await event in Rovenue.shared.changes {
                    self?.sendEvent("onChange", ["event": Self.eventName(event)])
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

    @available(iOS 15.0, macOS 12.0, *)
    private static func dtoFromStoreProduct(_ p: StoreProduct) -> [String: Any] {
        [
            "id": p.id,
            "type": productTypeString(p.type),
            "displayName": p.displayName,
            "priceString": p.priceString as Any,
            // Decimal → Double for the JS number bridge; NSNull when absent.
            "price": p.price.map { NSDecimalNumber(decimal: $0).doubleValue } as Any,
            "currencyCode": p.currencyCode as Any,
        ]
    }

    @available(iOS 15.0, macOS 12.0, *)
    private static func dtoFromOfferings(_ o: Offerings) -> [String: Any] {
        let offerings: [[String: Any]] = o.all.values.map { off in
            [
                "identifier": off.identifier,
                "isDefault": off.isDefault,
                "packages": off.packages.map { pkg in
                    [
                        "identifier": pkg.identifier,
                        "product": dtoFromStoreProduct(pkg.product),
                    ] as [String: Any]
                },
            ]
        }
        return [
            "current": o.current?.identifier as Any,
            "offerings": offerings,
        ]
    }

    private static func dtoFromPurchaseResult(_ r: PurchaseResult) -> [String: Any?] {
        [
            "entitlements": r.entitlements.map(dtoFromEntitlement),
            "virtualCurrencies": r.virtualCurrencies.mapValues { Double($0) },
            "productId": r.productId,
            "storeTransactionId": r.storeTransactionId,
        ]
    }

    /// Map the four Swift purchase-flow errors to Expo coded exceptions whose
    /// `code` matches the RN `mapNativeError` switch. Any other `Rovenue.Error`
    /// is rethrown unchanged (Expo surfaces its default code/message).
    private static func codedError(for e: Rovenue.Error) -> Exception {
        let message = e.errorDescription ?? "purchase error"
        switch e {
        case .purchaseCancelled:    return PurchaseCancelledException(message)
        case .purchasePending:      return PurchasePendingException(message)
        case .productNotAvailable:  return ProductNotAvailableException(message)
        case .storeProblem:         return StoreProblemException(message)
        default:                    return StoreProblemException(message)
        }
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
