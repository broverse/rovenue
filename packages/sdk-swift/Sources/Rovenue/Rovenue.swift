//  Rovenue.swift — public singleton façade over the Rust core (UniFFI-generated
//  `RovenueCore`). Lifecycle, identity, entitlements, credits, receipts,
//  and the observer stream all live here.
//
//  Threading: every async method that touches `RovenueCore` flows through
//  the internal `Dispatcher` (one serial queue, qos: .userInitiated). The
//  Rust core is itself thread-safe (Arc<Mutex<…>>); the Swift-side serial
//  queue keeps in-flight calls ordered without adding contention.

import Foundation
import StoreKit

// MARK: - LogEntry

/// A single log event emitted by the Rovenue façade. Forwarded to any
/// handler registered via `setLogHandler`. The `message` field is a
/// fixed string per emit site (no user input interpolation); the `data`
/// field is currently always `nil` (reserved for future structured
/// payloads, which MUST NOT include PII).
public struct LogEntry: Sendable {
    public let level: String   // "off" | "error" | "warn" | "info" | "debug" | "trace"
    public let message: String
    public let data: [String: String]?

    public init(level: String, message: String, data: [String: String]? = nil) {
        self.level = level
        self.message = message
        self.data = data
    }
}

// MARK: - Promotional offer validation (file-scope, testable function)

/// Resolves the offer id to redeem, throwing for offers that can't be redeemed via the promotional-offer path.
/// - Parameter offer: A `Discount` to validate and extract the identifier from, or nil.
/// - Returns: The offer identifier to pass to the purchase flow, or nil if no offer was provided.
/// - Throws: `RovenueError` with `.ineligible` kind if the offer is `.introductory` or missing an identifier.
internal func resolvePromotionalOfferId(_ offer: Discount?) throws -> String? {
    guard let offer else { return nil }
    guard offer.type != .introductory else {
        throw RovenueError(kind: .ineligible, message: "Introductory offers are applied automatically; do not pass them as a promotional offer.")
    }
    guard let id = offer.identifier else {
        throw RovenueError(kind: .ineligible, message: "Promotional offer is missing an identifier.")
    }
    return id
}

public final class Rovenue: @unchecked Sendable {
    // MARK: - Singleton plumbing
    //
    // Guarded by a single NSLock. Configure-twice replaces the instance
    // (RevenueCat / Adapty pattern). Accessing `.shared` before configure()
    // triggers fatalError — silent fallback would mask developer mistakes.

    private static let lock = NSLock()
    private static var _shared: Rovenue?

    public static var shared: Rovenue {
        lock.lock()
        defer { lock.unlock() }
        guard let instance = _shared else {
            fatalError("Rovenue: must call Rovenue.configure(apiKey:baseUrl:) before accessing shared")
        }
        return instance
    }

    /// Configure the SDK. Must be called before any other API.
    /// Throws `RovenueError(kind: .invalidApiKey, …)` if the api key is empty/whitespace.
    /// Calling this a second time replaces the shared instance.
    ///
    /// `appVersion` defaults to `Bundle.main.infoDictionary?["CFBundleShortVersionString"]`
    /// so the session-event telemetry payload carries the host app's user-facing
    /// version automatically. Pass an explicit value to override (tests / unusual
    /// bundle setups).
    public static func configure(
        apiKey: String,
        baseUrl: String? = nil,
        logLevel: LogLevel = .warn,
        appVersion: String? = nil,
        environment: String? = nil
    ) throws {
        guard !apiKey.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw RovenueError(kind: .invalidApiKey, message: "API key is missing or invalid")
        }
        let resolvedVersion = appVersion ?? readBundleAppVersion()
        // Omit baseUrl → the generated Config default ("https://api.rovenue.io")
        // applies; the Rust core validates it on construction.
        var config = Config(
            apiKey: apiKey,
            logLevel: logLevel,
            appVersion: resolvedVersion,
            platform: "ios",
            environment: environment
        )
        if let baseUrl {
            config.baseUrl = baseUrl
        }
        let core: RovenueCore
        do {
            core = try RovenueCore(config: config)
        } catch let err as RovenueErrorFfi {
            throw mapError(err)
        }
        let bridge = ObserverBridge()
        core.registerObserver(obs: bridge)
        core.registerLogSink(sink: LogSinkBridge())
        let funnelBridge = FunnelClaimBridge()
        core.registerFunnelClaimListener(listener: funnelBridge)
        let instance = Rovenue(core: core, bridge: bridge, funnelBridge: funnelBridge, appVersion: resolvedVersion)
        lock.lock()
        defer { lock.unlock() }
        _shared = instance
    }

    // -----------------------------------------------------------------
    // App-version reader — injectable for tests so we don't depend on
    // whatever Bundle.main resolves to inside an XCTest runner.
    // -----------------------------------------------------------------

    /// Test seam. Production callers leave this nil and the default
    /// Bundle.main lookup runs.
    internal static var _appVersionReaderForTesting: (() -> String?)?

    private static func readBundleAppVersion() -> String? {
        if let reader = _appVersionReaderForTesting {
            return reader()
        }
        return Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    /// Test-only: clears the shared instance so each test runs in isolation.
    /// Internal access through `@testable import Rovenue`.
    internal static func resetForTesting() {
        lock.lock()
        defer { lock.unlock() }
        if let s = _shared {
            s.transactionListener?.cancel()
            s.transactionListener = nil
            s.core.shutdown()
            s.bridge.finishAll()
            s.funnelBridge.finishAll()
        }
        _shared = nil
    }

    // MARK: - Log handlers
    //
    // Static dictionary (not cleared on configure-twice) so consumers
    // can install a handler once at app start and reconfigure without
    // silently losing it.

    private static let logLock = NSLock()
    private static var logHandlers: [UUID: (LogEntry) -> Void] = [:]

    /// Register a log handler that receives bridge-level events
    /// (configure / identify / refresh / receipt / shutdown).
    /// Returns an unsubscribe closure.
    @discardableResult
    public func setLogHandler(_ handler: @escaping (LogEntry) -> Void) -> () -> Void {
        let id = UUID()
        Self.logLock.lock(); Self.logHandlers[id] = handler; Self.logLock.unlock()
        return {
            Self.logLock.lock(); Self.logHandlers.removeValue(forKey: id); Self.logLock.unlock()
        }
    }

    internal static func emit(_ entry: LogEntry) {
        logLock.lock(); let snapshot = Array(logHandlers.values); logLock.unlock()
        snapshot.forEach { $0(entry) }
    }

    // MARK: - Instance state

    internal let core: RovenueCore
    internal let bridge: ObserverBridge
    internal let funnelBridge: FunnelClaimBridge
    internal let dispatcher: Dispatcher
    /// Captured at configure() time — exposed via
    /// `resolvedAppVersionForTesting` so tests can verify the wiring
    /// without scraping the actual session-event request body.
    private let appVersion: String?

    /// Background task draining `Transaction.updates` (renewals, refunds,
    /// Ask-to-Buy approvals, cross-device purchases). Started in `init`,
    /// cancelled in `shutdown()` / `resetForTesting()`.
    private var transactionListener: Task<Void, Never>?

    private init(core: RovenueCore, bridge: ObserverBridge, funnelBridge: FunnelClaimBridge, appVersion: String?) {
        self.core = core
        self.bridge = bridge
        self.funnelBridge = funnelBridge
        self.dispatcher = Dispatcher()
        self.appVersion = appVersion
        if #available(iOS 15.0, macOS 12.0, *) {
            startTransactionListener()
        }
    }

    /// Test-only accessor — used by `AppVersionTests` to verify that
    /// `configure(...)` correctly resolved the bundle / override.
    internal var resolvedAppVersionForTesting: String? { appVersion }

    // MARK: - Version

    public var version: String {
        sdkVersion()
    }

    // MARK: - Identity

    /// Returns the SDK's current user (anonymous ID + optional known ID).
    public func currentUser() async -> User {
        await dispatcher.runNonThrowing { [core] in
            core.currentUser()
        }
    }

    /// Associate the SDK's user with the customer's app-side user id.
    /// Client-local only — server-side merging happens via the customer's
    /// backend calling `/v1/subscribers/transfer` with the secret key.
    public func identify(_ appUserId: String) async throws {
        do {
            try await dispatcher.run { [core] in
                do {
                    try core.identify(appUserId: appUserId)
                } catch let err as RovenueErrorFfi {
                    throw mapError(err)
                }
            }
        } catch {
            throw error
        }
    }

    /// Reset the SDK to an anonymous state, discarding any associated app user id.
    /// The core generates a new anonymous `rovenueId`; `appUserId` becomes nil.
    @available(iOS 15.0, macOS 12.0, *)
    public func logOut() async throws {
        do {
            try await dispatcher.run { [core] in
                do { try core.logOut() } catch let e as RovenueErrorFfi { throw mapError(e) }
            }
        } catch {
            throw error
        }
    }

    // MARK: - Entitlements

    /// Fetch a specific entitlement from the local cache. Returns nil if it
    /// doesn't exist locally — does not hit the network.
    public func entitlement(_ id: String) async -> Entitlement? {
        await dispatcher.runNonThrowing { [core] in
            core.entitlement(id: id)
        }
    }

    /// List all cached entitlements. Does not hit the network.
    public func entitlementsAll() async -> [Entitlement] {
        await dispatcher.runNonThrowing { [core] in
            core.entitlementsAll()
        }
    }

    /// Force a refresh of the entitlements cache against the server.
    /// On success, emits `.entitlementsChanged` to subscribers of `changes`.
    public func refreshEntitlements() async throws {
        do {
            try await dispatcher.run { [core] in
                do {
                    try core.refreshEntitlements()
                } catch let err as RovenueErrorFfi {
                    throw mapError(err)
                }
            }
        } catch {
            throw error
        }
    }

    // MARK: - Virtual Currencies

    /// Read the cached virtual-currency balances (code → amount). Empty if uncached.
    public func virtualCurrencyBalances() async -> [String: Int64] {
        await dispatcher.runNonThrowing { [core] in
            core.virtualCurrencyBalances()
        }
    }

    /// Read the cached balance for a single virtual currency by code. Returns 0 if uncached.
    public func virtualCurrency(_ code: String) async -> Int64 {
        await dispatcher.runNonThrowing { [core] in
            core.virtualCurrency(code: code)
        }
    }

    /// Force a refresh of virtual-currency balances against the server.
    /// On success (when balances changed), emits `.virtualCurrenciesChanged`.
    public func refreshVirtualCurrencies() async throws {
        do {
            try await dispatcher.run { [core] in
                do {
                    try core.refreshVirtualCurrencies()
                } catch let err as RovenueErrorFfi {
                    throw mapError(err)
                }
            }
        } catch {
            throw error
        }
    }

    // MARK: - Remote Config

    /// Force a refresh of the remote config cache against the server.
    /// On success (when values changed), emits `.remoteConfigChanged`.
    public func refreshRemoteConfig() async throws {
        do {
            try await dispatcher.run { [core] in
                do {
                    try core.refreshRemoteConfig()
                } catch let err as RovenueErrorFfi {
                    throw mapError(err)
                }
            }
        } catch {
            throw error
        }
    }

    /// Read a boolean remote-config value from the local cache, returning
    /// `fallback` when the key is absent. Does not hit the network.
    public func remoteConfigBool(_ key: String, default fallback: Bool) async -> Bool {
        await dispatcher.runNonThrowing { [core] in
            core.remoteConfigBool(key: key, fallback: fallback)
        }
    }

    /// Read a string remote-config value from the local cache, returning
    /// `fallback` when the key is absent. Does not hit the network.
    public func remoteConfigString(_ key: String, default fallback: String) async -> String {
        await dispatcher.runNonThrowing { [core] in
            core.remoteConfigString(key: key, fallback: fallback)
        }
    }

    /// Read an integer remote-config value from the local cache, returning
    /// `fallback` when the key is absent. Does not hit the network.
    public func remoteConfigInt(_ key: String, default fallback: Int64) async -> Int64 {
        await dispatcher.runNonThrowing { [core] in
            core.remoteConfigInt(key: key, fallback: fallback)
        }
    }

    /// Read a double remote-config value from the local cache, returning
    /// `fallback` when the key is absent. Does not hit the network.
    public func remoteConfigDouble(_ key: String, default fallback: Double) async -> Double {
        await dispatcher.runNonThrowing { [core] in
            core.remoteConfigDouble(key: key, fallback: fallback)
        }
    }

    /// Read a raw JSON remote-config value from the local cache. Returns nil
    /// if the key is absent. Does not hit the network.
    public func remoteConfigJSON(_ key: String) async -> String? {
        await dispatcher.runNonThrowing { [core] in
            core.remoteConfigJson(key: key)
        }
    }

    /// List all cached remote-config keys. Does not hit the network.
    public func remoteConfigKeys() async -> [String] {
        await dispatcher.runNonThrowing { [core] in
            core.remoteConfigKeys()
        }
    }

    /// Return the full remote-config payload serialized as a JSON object.
    /// Does not hit the network.
    public func remoteConfigAllJSON() async -> String {
        await dispatcher.runNonThrowing { [core] in
            core.remoteConfigAllJson()
        }
    }

    /// Fetch the user's assignment for a single experiment from the local
    /// cache. Returns nil if the user is not enrolled. Does not hit the network.
    public func experiment(_ key: String) async -> ExperimentAssignment? {
        await dispatcher.runNonThrowing { [core] in
            core.experiment(key: key)
        }
    }

    /// List all of the user's experiment assignments from the local cache.
    /// Does not hit the network.
    public func experimentsAll() async -> [ExperimentAssignment] {
        await dispatcher.runNonThrowing { [core] in
            core.experimentsAll()
        }
    }

    // MARK: - Refund Shield — stable per-subscriber token

    /// Returns a stable UUID for the current user. The host app passes this
    /// to `Product.purchase(options: [.appAccountToken(uuid)])` so Apple's
    /// `CONSUMPTION_REQUEST` webhook can attribute the refund request back
    /// to a known subscriber.
    ///
    /// The token is generated once per (project, current_user_scope) pair
    /// and persisted locally. It is stable across app launches and reused
    /// for every subsequent purchase. Calling `identify()` first changes
    /// the scope, so the next `getAppAccountToken()` returns a different
    /// UUID for the now-known user.
    @discardableResult
    public func getAppAccountToken() async throws -> String {
        try await dispatcher.run { [core] in
            do { return try core.getOrCreateAppAccountToken() }
            catch let err as RovenueErrorFfi { throw mapError(err) }
        }
    }

    // MARK: - Refund Shield — session telemetry

    /// Record a single SDK session-lifecycle event (open / background / close).
    /// Buffered locally and flushed in batches of up to 200 every ~30s by the
    /// Rust core's `SessionDispatcher`. Best-effort: dropped on network error.
    public func recordSessionEvent(
        kind: SessionEventKind,
        occurredAt: String,
        durationMs: UInt32? = nil
    ) async throws {
        try await dispatcher.run { [core] in
            do {
                try core.recordSessionEvent(
                    kind: kind,
                    occurredAt: occurredAt,
                    durationMs: durationMs
                )
            } catch let err as RovenueErrorFfi {
                throw mapError(err)
            }
        }
    }

    /// Send a pre-serialised event envelope to the server (POST /v1/events).
    /// The caller is responsible for building the JSON envelope; this method
    /// forwards it verbatim to the Rust core and then to the API.
    public func track(envelopeJson: String) async throws {
        do {
            try await dispatcher.run { [core] in
                do {
                    try core.track(envelopeJson: envelopeJson)
                } catch let err as RovenueErrorFfi {
                    throw mapError(err)
                }
            }
        } catch {
            throw error
        }
    }

    /// Force an immediate flush of buffered session events. Returns the
    /// number of events drained. Normally callers don't invoke this — the
    /// Rust core's 30s poll covers it.
    @discardableResult
    public func flushSessionEvents() async throws -> UInt32 {
        try await dispatcher.run { [core] in
            do { return try core.flushSessionEvents() }
            catch let err as RovenueErrorFfi { throw mapError(err) }
        }
    }

    // MARK: - Subscriber attributes

    /// Queue a batch of subscriber-attribute mutations. A `nil` value deletes
    /// the key. Written locally immediately; flushed to the server in the
    /// background (30s tick / foreground / manual `flushAttributes`).
    public func setAttributes(_ attributes: [String: String?]) async throws {
        do {
            try await dispatcher.run { [core] in
                do {
                    try core.setAttributes(attributes: attributes)
                } catch let err as RovenueErrorFfi {
                    throw mapError(err)
                }
            }
        } catch {
            throw error
        }
    }

    /// Set (or, with `nil`, clear) the reserved `$email` attribute.
    public func setEmail(_ email: String?) async throws { try await setAttributes(["$email": email]) }
    /// Set (or, with `nil`, clear) the reserved `$displayName` attribute.
    public func setDisplayName(_ name: String?) async throws { try await setAttributes(["$displayName": name]) }
    /// Set (or, with `nil`, clear) the reserved `$phoneNumber` attribute.
    public func setPhoneNumber(_ phone: String?) async throws { try await setAttributes(["$phoneNumber": phone]) }
    /// iOS push token → the `$apnsTokens` reserved attribute.
    public func setPushToken(_ token: String?) async throws { try await setAttributes(["$apnsTokens": token]) }

    /// Force an immediate flush of queued attribute mutations. Returns the
    /// number of mutations sent. Normally callers don't invoke this — the
    /// Rust core's 30s poll covers it.
    @discardableResult
    public func flushAttributes() async throws -> UInt32 {
        try await dispatcher.run { [core] in
            do { return try core.flushAttributes() }
            catch let err as RovenueErrorFfi { throw mapError(err) }
        }
    }

    // MARK: - Lifecycle hooks

    /// Tell the SDK whether the app is in the foreground. While foreground,
    /// the SDK's internal polling scheduler ticks; while background, polling
    /// pauses. Call from your AppDelegate / SceneDelegate.
    public func setForeground(_ foreground: Bool) {
        core.setForeground(foreground: foreground)
    }

    /// Stop background work cleanly. Called automatically on `resetForTesting`.
    public func shutdown() {
        transactionListener?.cancel()
        transactionListener = nil
        core.shutdown()
    }

    // MARK: - Purchasing
    //
    // SDK-driven StoreKit 2 purchasing. The SDK runs the StoreKit flow,
    // validates the resulting JWS against the Rovenue backend, and only then
    // finishes the transaction. The legacy "host app posts the receipt"
    // surface is gone — callers no longer touch StoreKit directly.

    /// Fetch the project's offerings and enrich each product with live
    /// StoreKit price metadata. The list of offerings (and which one is
    /// `current`) comes from the Rovenue backend; prices come from StoreKit.
    /// Products missing from StoreKit still appear, just without price fields.
    @available(iOS 15.0, macOS 12.0, *)
    public func getOfferings() async throws -> Offerings {
        let ffi: CoreOfferings
        do {
            ffi = try await dispatcher.run { [core] in
                do { return try core.getOfferings() }
                catch let err as RovenueErrorFfi { throw mapError(err) }
            }
        } catch {
            throw error
        }

        // Batch-load every Apple product id referenced across all offerings.
        let appleIds = ffi.offerings
            .flatMap { $0.packages }
            .compactMap { $0.appleProductId }
        let skProducts = await StoreKitAppleStore().products(for: Array(Set(appleIds)))

        func buildProduct(_ p: CoreOfferingProduct) async -> StoreProduct {
            guard let product = p.appleProductId.flatMap({ skProducts[$0] }) else {
                // No StoreKit product found — return config-only product.
                return mapAppleStoreProduct(core: p, period: nil, introOffer: nil,
                    promoOffers: [], groupId: nil, isFamilyShareable: false, description: nil,
                    priceString: nil, price: nil, currencyCode: nil, isEligible: nil, raw: nil,
                    formatCurrency: { _ in nil })
            }
            let offers = appleOfferInputs(from: product)
            let isEligible = try? await product.subscription?.isEligibleForIntroOffer
            let priceString = product.displayPrice
            let price = product.price
            let currencyCode = product.priceFormatStyle.currencyCode
            let fmtStyle = product.priceFormatStyle
            let formatCurrency: (Decimal) -> String? = { $0.formatted(fmtStyle) }
            return mapAppleStoreProduct(core: p, period: offers.period, introOffer: offers.intro,
                promoOffers: offers.promos, groupId: offers.groupId,
                isFamilyShareable: product.isFamilyShareable, description: product.description,
                priceString: priceString, price: price, currencyCode: currencyCode,
                isEligible: isEligible, raw: product, formatCurrency: formatCurrency)
        }

        func buildOffering(_ o: CoreOffering) async -> Offering {
            var packages: [Package] = []
            for pkg in o.packages {
                packages.append(Package(identifier: pkg.packageIdentifier, packageType: packageType(forSlot: pkg.packageIdentifier),
                                        product: await buildProduct(pkg)))
            }
            return Offering(
                identifier: o.identifier,
                isDefault: o.isDefault,
                // Use packageIdentifier (the slot id, e.g. $rov_monthly) as
                // Package.identifier — that is the value the SDK contract
                // exposes to callers. The product's App Store SKU (the id used
                // for StoreKit lookups and purchases) is available via
                // pkg.product.id.
                packages: packages
            )
        }

        var offerings: [Offering] = []
        for o in ffi.offerings {
            offerings.append(await buildOffering(o))
        }
        let all = Dictionary(uniqueKeysWithValues: offerings.map { ($0.identifier, $0) })
        let current = ffi.current.flatMap { all[$0] }
        return Offerings(current: current, all: all)
    }

    /// Purchase the product backing a `Package`, optionally with a signed promotional offer.
    @available(iOS 15.0, macOS 12.0, *)
    public func purchase(_ package: Package, promotionalOffer: Discount? = nil) async throws -> PurchaseResult {
        try await purchase(package.product, promotionalOffer: promotionalOffer)
    }

    /// Purchase a `StoreProduct` by promotional offer id directly.
    /// The offer id is used as-is — no introductory/identifier guards are applied.
    /// The RN bridge calls this overload directly.
    @available(iOS 15.0, macOS 12.0, *)
    public func purchase(_ product: StoreProduct, promotionalOfferId: String) async throws -> PurchaseResult {
        try await _purchaseCore(product: product, offerId: promotionalOfferId)
    }

    /// Purchase a `StoreProduct`. Runs the StoreKit flow, validates the JWS
    /// server-side, finishes the transaction, then returns refreshed state.
    /// Pass a `promotionalOffer` (`.promotional` or `.winBack`) to sign and
    /// inject a promotional offer; `.introductory` throws immediately.
    @available(iOS 15.0, macOS 12.0, *)
    public func purchase(_ product: StoreProduct, promotionalOffer: Discount? = nil) async throws -> PurchaseResult {
        let offerId = try resolvePromotionalOfferId(promotionalOffer)
        return try await _purchaseCore(product: product, offerId: offerId)
    }

    /// Single-sourced purchase implementation used by all public purchase overloads.
    @available(iOS 15.0, macOS 12.0, *)
    private func _purchaseCore(product: StoreProduct, offerId: String?) async throws -> PurchaseResult {
        let token = try? await getAppAccountToken()
        let flow = ApplePurchaseFlow(
            store: StoreKitAppleStore(),
            validate: { [core] jws, pid in
                try await self.dispatcher.run {
                    do {
                        return try core.postAppleReceipt(receipt: jws, productId: pid, appAccountToken: token)
                    } catch let err as RovenueErrorFfi {
                        throw mapError(err)
                    }
                }
            },
            signOffer: { [core] pid, oid, tok in
                try await self.dispatcher.run {
                    do {
                        let sig = try core.getAppleOfferSignature(productId: pid, offerId: oid, appAccountToken: tok.isEmpty ? nil : tok)
                        return AppleSignedOffer(offerId: oid, keyId: sig.keyIdentifier, nonce: sig.nonce, signatureBase64: sig.signature, timestamp: Int(sig.timestamp))
                    } catch let err as RovenueErrorFfi { throw mapError(err) }
                }
            }
        )
        return try await flow.run(productId: product.id, appAccountToken: token, promotionalOfferId: offerId)
    }

    /// Restore the user's prior purchases. Syncs with the App Store, re-posts
    /// every current entitlement's JWS for validation (best-effort), then
    /// refreshes and returns the resulting entitlement/credit state.
    @available(iOS 15.0, macOS 12.0, *)
    public func restorePurchases() async throws -> PurchaseResult {
        try? await AppStore.sync()
        for await result in Transaction.currentEntitlements {
            guard case let .verified(t) = result else { continue }
            _ = try? await dispatcher.run { [core] in
                try? core.postAppleReceipt(
                    receipt: result.jwsRepresentation,
                    productId: t.productID,
                    appAccountToken: nil
                )
            }
        }
        try await refreshEntitlements()
        let result = PurchaseResult(
            entitlements: await entitlementsAll(),
            virtualCurrencies: await virtualCurrencyBalances(),
            productId: "",
            storeTransactionId: ""
        )
        return result
    }

    /// Drain `Transaction.updates` for the lifetime of the instance, posting
    /// each verified update's JWS to the backend and finishing the transaction.
    /// Covers renewals, refunds, Ask-to-Buy approvals, and cross-device buys.
    @available(iOS 15.0, macOS 12.0, *)
    private func startTransactionListener() {
        transactionListener = Task.detached { [weak self] in
            for await update in Transaction.updates {
                guard let self else { break }
                if case let .verified(t) = update {
                    let validated = (try? await self.dispatcher.run { [core = self.core] in
                        try core.postAppleReceipt(
                            receipt: update.jwsRepresentation,
                            productId: t.productID,
                            appAccountToken: nil
                        )
                    }) != nil
                    if validated {
                        await t.finish()
                    }
                    // validation failed → leave unfinished; StoreKit re-delivers, listener retries.
                }
            }
        }
    }

    // MARK: - Observer stream

    /// AsyncStream of cache-change notifications. Each access returns a new
    /// stream — subscribing twice (one per view, say) is supported. Stream
    /// termination on cancel deregisters the subscriber automatically.
    public var changes: AsyncStream<ChangeEvent> {
        bridge.subscribe()
    }

    // MARK: - Funnel Claim

    /// AsyncStream of resolved funnel-claim events. Each access returns a new
    /// stream. Mirrors `changes` / `ObserverBridge` but carries a
    /// `FunnelClaimResult` payload.
    public var funnelClaims: AsyncStream<FunnelClaimResult> {
        funnelBridge.subscribe()
    }

    /// Returns the SDK's stable install ID (a device-scoped anonymous
    /// identifier generated once and persisted locally). Synchronous —
    /// backed by the Rust MMKV store.
    public func installId() -> String {
        core.installId()
    }

    public func hasResolvedFunnelClaim() -> Bool {
        core.hasResolvedFunnelClaim()
    }

    /// Claim a funnel token (from a deep-link or QR code). Returns the
    /// resolved subscriber record immediately and also emits on `funnelClaims`.
    public func claimFunnelToken(_ token: String) async throws -> FunnelClaimResult {
        try await dispatcher.run { [core] in
            do { return try core.claimFunnelToken(token: token) }
            catch let err as RovenueErrorFfi { throw mapError(err) }
        }
    }

    /// Claim install attribution. Returns the resolved record when an
    /// unattributed install matches a pending funnel token; returns `nil`
    /// when no match is found.
    public func claimInstall(_ params: ClaimInstallParams) async throws -> FunnelClaimResult? {
        try await dispatcher.run { [core] in
            do { return try core.claimInstall(params: params) }
            catch let err as RovenueErrorFfi { throw mapError(err) }
        }
    }

    /// Claim by email address. The backend matches an install token to the
    /// provided email; completes without returning a value (resolution is
    /// notified via the `funnelClaims` stream).
    public func claimViaEmail(_ email: String) async throws {
        try await dispatcher.run { [core] in
            do { try core.claimViaEmail(email: email) }
            catch let err as RovenueErrorFfi { throw mapError(err) }
        }
    }
}
