// HybridRovenueNitroSpec.swift — Nitro HybridObject implementation
// forwarding to the M3 Swift `Rovenue` singleton.
//
// Compile target: iOS 13+. Depends on:
//   - NitroModules framework (via react-native-nitro-modules)
//   - Rovenue Swift module (via @rovenue/sdk-swift SPM package)
//
// The Nitrogen tool will normally generate a `HybridRovenueNitroSpecSpec`
// protocol from the .nitro.ts file; for M5 we hand-write the conformance
// against the expected protocol shape. M6's `pnpm nitrogen` step will
// regenerate the protocol; this implementation should remain compatible.
//
// DTO mapping notes (M3 Swift types -> RN-bridge DTOs as declared in
// `src/specs/RovenueNitroSpec.nitro.ts`):
//   * Entitlement: M3 has { id, isActive, productIdentifier, store, expiresIso }
//                  bridge ships { id, active, expiresAt, productId }
//                  (`store` is intentionally dropped on the RN side for now).
//   * ReceiptResult: M3 returns { subscriberId, appUserId, creditBalance }.
//                   M3's `postAppleReceipt` / `postGoogleReceipt` only resolve
//                   on success and the docstring guarantees entitlements +
//                   credits caches were refreshed on success. We therefore
//                   synthesize { ok: true, entitlementsRefreshed: true,
//                                creditsRefreshed: true } when the call
//                   returns; failures propagate as thrown errors.
//   * `Rovenue.shared.currentUser()` is `async` (non-throwing) — we expose it
//     as `async throws` to match the Nitro spec but never actually throw.
//   * `Rovenue.shared.entitlement(_:)`, `entitlementsAll()`, `creditBalance()`
//     are `async` (non-throwing) — same treatment.
//   * Most M3 methods use unlabeled first params (`identify(_:)`,
//     `entitlement(_:)`, `consumeCredits(_:description:)`,
//     `postAppleReceipt(_:productId:)`, `postGoogleReceipt(_:productId:)`).

import Foundation
import NitroModules
import Rovenue  // Swift M3 package

final class HybridRovenueNitroSpec: HybridObject {

    // -------- Lifecycle --------
    func configure(apiKey: String, baseUrl: String, debug: Bool) throws {
        try Rovenue.configure(apiKey: apiKey, baseUrl: baseUrl, debug: debug)
    }

    func shutdown() {
        Rovenue.shared.shutdown()
    }

    func setForeground(foreground: Bool) {
        Rovenue.shared.setForeground(foreground)
    }

    func getVersion() -> String {
        return Rovenue.shared.version
    }

    // -------- Identity --------
    func currentUser() async throws -> [String: Any?] {
        let u = await Rovenue.shared.currentUser()
        return [
            "anonId": u.anonId,
            "knownUserId": u.knownUserId as Any?,
        ]
    }

    func identify(knownUserId: String) async throws {
        try await Rovenue.shared.identify(knownUserId)
    }

    // -------- Entitlements --------
    func entitlement(id: String) async throws -> [String: Any?]? {
        guard let e = await Rovenue.shared.entitlement(id) else { return nil }
        return Self.dtoFromEntitlement(e)
    }

    func entitlementsAll() async throws -> [[String: Any?]] {
        let all = await Rovenue.shared.entitlementsAll()
        return all.map(Self.dtoFromEntitlement)
    }

    func refreshEntitlements() async throws {
        try await Rovenue.shared.refreshEntitlements()
    }

    // -------- Credits --------
    func creditBalance() async throws -> Double {
        let b = await Rovenue.shared.creditBalance()
        return Double(b)  // Nitro JS Number is Double; Int64 → Double is lossless up to 2^53
    }

    func refreshCredits() async throws {
        try await Rovenue.shared.refreshCredits()
    }

    func consumeCredits(amount: Double, description: String?) async throws -> Double {
        let b = try await Rovenue.shared.consumeCredits(
            Int64(amount),
            description: description
        )
        return Double(b)
    }

    // -------- Receipts --------
    func postAppleReceipt(jws: String, productId: String) async throws -> [String: Any?] {
        _ = try await Rovenue.shared.postAppleReceipt(jws, productId: productId)
        // M3 only returns on success and guarantees both caches were refreshed.
        return [
            "ok": true,
            "entitlementsRefreshed": true,
            "creditsRefreshed": true,
        ]
    }

    func postGoogleReceipt(receipt: String, productId: String) async throws -> [String: Any?] {
        _ = try await Rovenue.shared.postGoogleReceipt(receipt, productId: productId)
        return [
            "ok": true,
            "entitlementsRefreshed": true,
            "creditsRefreshed": true,
        ]
    }

    // -------- Observer --------
    func addChangeListener(cb: @escaping (String) -> Void) -> () -> Void {
        let task = Task {
            for await event in Rovenue.shared.changes {
                cb(Self.eventName(event))
            }
        }
        return { task.cancel() }
    }

    // -------- Helpers --------
    private static func dtoFromEntitlement(_ e: Entitlement) -> [String: Any?] {
        return [
            "id": e.id,
            "active": e.isActive,
            "expiresAt": e.expiresIso as Any?,
            "productId": e.productIdentifier as Any?,
        ]
    }

    private static func eventName(_ event: ChangeEvent) -> String {
        switch event {
        case .entitlementsChanged:    return "ENTITLEMENTS_CHANGED"
        case .identityChanged:        return "IDENTITY_CHANGED"
        case .creditBalanceChanged:   return "CREDIT_BALANCE_CHANGED"
        }
    }
}
