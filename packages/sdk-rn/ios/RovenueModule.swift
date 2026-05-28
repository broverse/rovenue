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

public class RovenueModule: Module {
    private var changesTask: Task<Void, Never>?
    private var logUnsubscribe: (() -> Void)?

    public func definition() -> ModuleDefinition {
        Name("Rovenue")

        // ---------------- Sync ----------------
        Function("configure") { (apiKey: String, baseUrl: String, debug: Bool) in
            try Rovenue.configure(apiKey: apiKey, baseUrl: baseUrl, debug: debug)
        }
        Function("shutdown") { Rovenue.shared.shutdown() }
        Function("setForeground") { (foreground: Bool) in
            Rovenue.shared.setForeground(foreground)
        }
        Function("getVersion") { () -> String in Rovenue.shared.version }

        // ---------------- Async ----------------
        AsyncFunction("currentUser") { () -> [String: Any?] in
            let u = await Rovenue.shared.currentUser()
            return ["anonId": u.anonId, "knownUserId": u.knownUserId as Any?]
        }
        AsyncFunction("identify") { (knownUserId: String) in
            try await Rovenue.shared.identify(knownUserId)
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
        AsyncFunction("creditBalance") { () -> Double in
            // Long → Double is lossless up to 2^53.
            Double(await Rovenue.shared.creditBalance())
        }
        AsyncFunction("refreshCredits") { try await Rovenue.shared.refreshCredits() }
        AsyncFunction("consumeCredits") { (amount: Double, description: String?) -> Double in
            let b = try await Rovenue.shared.consumeCredits(Int64(amount), description: description)
            return Double(b)
        }
        AsyncFunction("postAppleReceipt") { (jws: String, productId: String, appAccountToken: String?) -> [String: Any?] in
            _ = try await Rovenue.shared.postAppleReceipt(
                jws,
                productId: productId,
                appAccountToken: appAccountToken
            )
            // M3 only resolves on success and guarantees both caches refreshed.
            return ["ok": true, "entitlementsRefreshed": true, "creditsRefreshed": true]
        }
        AsyncFunction("postGoogleReceipt") { (receipt: String, productId: String, obfAccount: String?, obfProfile: String?) -> [String: Any?] in
            // On iOS this is unreachable but kept for surface parity.
            _ = try await Rovenue.shared.postGoogleReceipt(
                receipt,
                productId: productId,
                obfuscatedAccountId: obfAccount,
                obfuscatedProfileId: obfProfile
            )
            return ["ok": true, "entitlementsRefreshed": true, "creditsRefreshed": true]
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
    private static func eventName(_ event: ChangeEvent) -> String {
        switch event {
        case .entitlementsChanged: return "ENTITLEMENTS_CHANGED"
        case .identityChanged:     return "IDENTITY_CHANGED"
        case .creditBalanceChanged: return "CREDIT_BALANCE_CHANGED"
        }
    }
}
