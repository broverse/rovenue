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
    public let level: String   // "debug" | "info" | "warn" | "error"
    public let message: String
    public let data: [String: String]?

    public init(level: String, message: String, data: [String: String]? = nil) {
        self.level = level
        self.message = message
        self.data = data
    }
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
    /// Throws `Rovenue.Error.invalidApiKey` if the api key is empty/whitespace.
    /// Calling this a second time replaces the shared instance.
    ///
    /// `appVersion` defaults to `Bundle.main.infoDictionary?["CFBundleShortVersionString"]`
    /// so the session-event telemetry payload carries the host app's user-facing
    /// version automatically. Pass an explicit value to override (tests / unusual
    /// bundle setups).
    public static func configure(
        apiKey: String,
        baseUrl: String,
        debug: Bool = false,
        appVersion: String? = nil
    ) throws {
        emit(LogEntry(level: "info", message: "configure"))
        guard !apiKey.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw Rovenue.Error.invalidApiKey
        }
        let resolvedVersion = appVersion ?? readBundleAppVersion()
        let config = Config(
            apiKey: apiKey,
            baseUrl: baseUrl,
            debug: debug,
            appVersion: resolvedVersion
        )
        let core: RovenueCore
        do {
            core = try RovenueCore(config: config)
        } catch let err as RovenueError {
            throw mapError(err)
        }
        let bridge = ObserverBridge()
        core.registerObserver(obs: bridge)
        let instance = Rovenue(core: core, bridge: bridge, appVersion: resolvedVersion)
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
    internal let dispatcher: Dispatcher
    /// Captured at configure() time — exposed via
    /// `resolvedAppVersionForTesting` so tests can verify the wiring
    /// without scraping the actual session-event request body.
    private let appVersion: String?

    /// Background task draining `Transaction.updates` (renewals, refunds,
    /// Ask-to-Buy approvals, cross-device purchases). Started in `init`,
    /// cancelled in `shutdown()` / `resetForTesting()`.
    private var transactionListener: Task<Void, Never>?

    private init(core: RovenueCore, bridge: ObserverBridge, appVersion: String?) {
        self.core = core
        self.bridge = bridge
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
    public func identify(_ knownUserId: String) async throws {
        Self.emit(LogEntry(level: "info", message: "identify"))
        do {
            try await dispatcher.run { [core] in
                do {
                    try core.identify(knownUserId: knownUserId)
                } catch let err as RovenueError {
                    throw mapError(err)
                }
            }
            Self.emit(LogEntry(level: "info", message: "identify ok"))
        } catch {
            Self.emit(LogEntry(level: "error", message: "identify failed: \(error.localizedDescription)"))
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
        Self.emit(LogEntry(level: "info", message: "refreshEntitlements"))
        do {
            try await dispatcher.run { [core] in
                do {
                    try core.refreshEntitlements()
                } catch let err as RovenueError {
                    throw mapError(err)
                }
            }
            Self.emit(LogEntry(level: "info", message: "refreshEntitlements ok"))
        } catch {
            Self.emit(LogEntry(level: "error", message: "refreshEntitlements failed: \(error.localizedDescription)"))
            throw error
        }
    }

    // MARK: - Credits

    /// Read the cached credit balance. Returns 0 if the cache is empty.
    public func creditBalance() async -> Int64 {
        await dispatcher.runNonThrowing { [core] in
            core.creditBalance()
        }
    }

    /// Force a refresh of the credit balance against the server.
    /// On success (when the balance changed), emits `.creditBalanceChanged`.
    public func refreshCredits() async throws {
        Self.emit(LogEntry(level: "info", message: "refreshCredits"))
        do {
            try await dispatcher.run { [core] in
                do {
                    try core.refreshCredits()
                } catch let err as RovenueError {
                    throw mapError(err)
                }
            }
            Self.emit(LogEntry(level: "info", message: "refreshCredits ok"))
        } catch {
            Self.emit(LogEntry(level: "error", message: "refreshCredits failed: \(error.localizedDescription)"))
            throw error
        }
    }

    /// Spend credits server-side. The SDK generates an Idempotency-Key
    /// internally — retries of the same call are server-deduped.
    /// Returns the new balance.
    /// Throws `.insufficientCredits` if the user lacks the balance.
    public func consumeCredits(_ amount: Int64, description: String? = nil) async throws -> Int64 {
        Self.emit(LogEntry(level: "info", message: "consumeCredits"))
        do {
            let result = try await dispatcher.run { [core] in
                do {
                    return try core.consumeCredits(amount: amount, description: description)
                } catch let err as RovenueError {
                    throw mapError(err)
                }
            }
            Self.emit(LogEntry(level: "info", message: "consumeCredits ok"))
            return result
        } catch {
            Self.emit(LogEntry(level: "error", message: "consumeCredits failed: \(error.localizedDescription)"))
            throw error
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
            catch let err as RovenueError { throw mapError(err) }
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
            } catch let err as RovenueError {
                throw mapError(err)
            }
        }
    }

    /// Force an immediate flush of buffered session events. Returns the
    /// number of events drained. Normally callers don't invoke this — the
    /// Rust core's 30s poll covers it.
    @discardableResult
    public func flushSessionEvents() async throws -> UInt32 {
        try await dispatcher.run { [core] in
            do { return try core.flushSessionEvents() }
            catch let err as RovenueError { throw mapError(err) }
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
        Self.emit(LogEntry(level: "info", message: "shutdown"))
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
        Self.emit(LogEntry(level: "info", message: "getOfferings"))
        let ffi: CoreOfferings
        do {
            ffi = try await dispatcher.run { [core] in
                do { return try core.getOfferings() }
                catch let err as RovenueError { throw mapError(err) }
            }
        } catch {
            Self.emit(LogEntry(level: "error", message: "getOfferings failed: \(error.localizedDescription)"))
            throw error
        }

        // Batch-load every Apple product id referenced across all offerings.
        let appleIds = ffi.offerings
            .flatMap { $0.packages }
            .compactMap { $0.appleProductId }
        let skProducts = await StoreKitAppleStore().products(for: Array(Set(appleIds)))

        func buildProduct(_ p: CoreOfferingProduct) -> StoreProduct {
            let sk = p.appleProductId.flatMap { skProducts[$0] }
            return StoreProduct(
                id: p.appleProductId ?? p.identifier,
                type: ProductType.from(p.productType),
                displayName: sk?.displayName ?? p.displayName,
                priceString: sk?.displayPrice,
                price: sk?.price,
                currencyCode: sk?.priceFormatStyle.currencyCode
            )
        }

        func buildOffering(_ o: CoreOffering) -> Offering {
            Offering(
                identifier: o.identifier,
                isDefault: o.isDefault,
                packages: o.packages.map { Package(identifier: $0.identifier, product: buildProduct($0)) }
            )
        }

        let offerings = ffi.offerings.map(buildOffering)
        let all = Dictionary(uniqueKeysWithValues: offerings.map { ($0.identifier, $0) })
        let current = ffi.current.flatMap { all[$0] }
        Self.emit(LogEntry(level: "info", message: "getOfferings ok"))
        return Offerings(current: current, all: all)
    }

    /// Purchase the product backing a `Package`.
    @available(iOS 15.0, macOS 12.0, *)
    public func purchase(_ package: Package) async throws -> PurchaseResult {
        try await purchase(package.product)
    }

    /// Purchase a `StoreProduct`. Runs the StoreKit flow, validates the JWS
    /// server-side, finishes the transaction, then returns refreshed state.
    @available(iOS 15.0, macOS 12.0, *)
    public func purchase(_ product: StoreProduct) async throws -> PurchaseResult {
        Self.emit(LogEntry(level: "info", message: "purchase"))
        let token = try? await getAppAccountToken()
        let flow = ApplePurchaseFlow(
            store: StoreKitAppleStore(),
            validate: { [core] jws, pid in
                try await self.dispatcher.run {
                    do {
                        return try core.postAppleReceipt(receipt: jws, productId: pid, appAccountToken: token)
                    } catch let err as RovenueError {
                        throw mapError(err)
                    }
                }
            },
            snapshot: { [weak self] in
                guard let self else { return ([], 0) }
                return (await self.entitlementsAll(), await self.creditBalance())
            }
        )
        do {
            let result = try await flow.run(productId: product.id, appAccountToken: token)
            Self.emit(LogEntry(level: "info", message: "purchase ok"))
            return result
        } catch {
            Self.emit(LogEntry(level: "error", message: "purchase failed: \(error.localizedDescription)"))
            throw error
        }
    }

    /// Restore the user's prior purchases. Syncs with the App Store, re-posts
    /// every current entitlement's JWS for validation (best-effort), then
    /// refreshes and returns the resulting entitlement/credit state.
    @available(iOS 15.0, macOS 12.0, *)
    public func restorePurchases() async throws -> PurchaseResult {
        Self.emit(LogEntry(level: "info", message: "restorePurchases"))
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
            creditBalance: await creditBalance(),
            productId: "",
            storeTransactionId: ""
        )
        Self.emit(LogEntry(level: "info", message: "restorePurchases ok"))
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
                    _ = try? await self.dispatcher.run { [core = self.core] in
                        try? core.postAppleReceipt(
                            receipt: update.jwsRepresentation,
                            productId: t.productID,
                            appAccountToken: nil
                        )
                    }
                    await t.finish()
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
}
