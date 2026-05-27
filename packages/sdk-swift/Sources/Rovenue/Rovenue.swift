//  Rovenue.swift — public singleton façade over the Rust core (UniFFI-generated
//  `RovenueCore`). Lifecycle, identity, entitlements, credits, receipts,
//  and the observer stream all live here.
//
//  Threading: every async method that touches `RovenueCore` flows through
//  the internal `Dispatcher` (one serial queue, qos: .userInitiated). The
//  Rust core is itself thread-safe (Arc<Mutex<…>>); the Swift-side serial
//  queue keeps in-flight calls ordered without adding contention.

import Foundation

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
    public static func configure(apiKey: String, baseUrl: String, debug: Bool = false) throws {
        guard !apiKey.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw Rovenue.Error.invalidApiKey
        }
        let config = Config(apiKey: apiKey, baseUrl: baseUrl, debug: debug)
        let core: RovenueCore
        do {
            core = try RovenueCore(config: config)
        } catch let err as RovenueError {
            throw mapError(err)
        }
        let bridge = ObserverBridge()
        core.registerObserver(obs: bridge)
        let instance = Rovenue(core: core, bridge: bridge)
        lock.lock()
        defer { lock.unlock() }
        _shared = instance
    }

    /// Test-only: clears the shared instance so each test runs in isolation.
    /// Internal access through `@testable import Rovenue`.
    internal static func resetForTesting() {
        lock.lock()
        defer { lock.unlock() }
        if let s = _shared {
            s.core.shutdown()
            s.bridge.finishAll()
        }
        _shared = nil
    }

    // MARK: - Instance state

    internal let core: RovenueCore
    internal let bridge: ObserverBridge
    internal let dispatcher: Dispatcher

    private init(core: RovenueCore, bridge: ObserverBridge) {
        self.core = core
        self.bridge = bridge
        self.dispatcher = Dispatcher()
    }

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
        try await dispatcher.run { [core] in
            do {
                try core.identify(knownUserId: knownUserId)
            } catch let err as RovenueError {
                throw mapError(err)
            }
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
        try await dispatcher.run { [core] in
            do {
                try core.refreshEntitlements()
            } catch let err as RovenueError {
                throw mapError(err)
            }
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
        try await dispatcher.run { [core] in
            do {
                try core.refreshCredits()
            } catch let err as RovenueError {
                throw mapError(err)
            }
        }
    }

    /// Spend credits server-side. The SDK generates an Idempotency-Key
    /// internally — retries of the same call are server-deduped.
    /// Returns the new balance.
    /// Throws `.insufficientCredits` if the user lacks the balance.
    public func consumeCredits(_ amount: Int64, description: String? = nil) async throws -> Int64 {
        try await dispatcher.run { [core] in
            do {
                return try core.consumeCredits(amount: amount, description: description)
            } catch let err as RovenueError {
                throw mapError(err)
            }
        }
    }

    // MARK: - Receipts

    /// Post an Apple StoreKit 2 JWS to the server for validation.
    /// The caller is responsible for obtaining the JWS via `Product.purchase()`
    /// (or `Transaction.currentEntitlements`) — this SDK does NOT call StoreKit.
    /// On success, refreshes entitlements + credits and returns a `ReceiptResult`.
    public func postAppleReceipt(_ jws: String, productId: String) async throws -> ReceiptResult {
        try await dispatcher.run { [core] in
            do {
                return try core.postAppleReceipt(receipt: jws, productId: productId)
            } catch let err as RovenueError {
                throw mapError(err)
            }
        }
    }

    /// Post a Google Play Billing purchase token to the server for validation.
    /// The caller obtains the token via `Purchase.purchaseToken` after a
    /// successful Play Billing flow on Android. (Provided here for completeness
    /// — Swift code on iOS won't use this method.)
    /// On success, refreshes entitlements + credits and returns a `ReceiptResult`.
    public func postGoogleReceipt(_ receipt: String, productId: String) async throws -> ReceiptResult {
        try await dispatcher.run { [core] in
            do {
                return try core.postGoogleReceipt(receipt: receipt, productId: productId)
            } catch let err as RovenueError {
                throw mapError(err)
            }
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
        core.shutdown()
    }

    // MARK: - Observer stream

    /// AsyncStream of cache-change notifications. Each access returns a new
    /// stream — subscribing twice (one per view, say) is supported. Stream
    /// termination on cancel deregisters the subscriber automatically.
    public var changes: AsyncStream<ChangeEvent> {
        bridge.subscribe()
    }
}
