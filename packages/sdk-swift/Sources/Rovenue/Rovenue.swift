//  Rovenue.swift — public singleton façade over the Rust core (UniFFI-generated
//  `RovenueCore`). Lifecycle, identity, entitlements, credits, receipts,
//  and the observer stream all live here.
//
//  Threading: every async method that touches `RovenueCore` flows through
//  the internal `Dispatcher` (one serial queue, qos: .userInitiated). The
//  Rust core is itself thread-safe (Arc<Mutex<…>>); the Swift-side serial
//  queue keeps in-flight calls ordered without adding contention.

import Foundation

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
    public static func configure(apiKey: String, baseUrl: String, debug: Bool = false) throws {
        emit(LogEntry(level: "info", message: "configure"))
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

    // MARK: - Receipts

    /// Post an Apple StoreKit 2 JWS to the server for validation.
    /// The caller is responsible for obtaining the JWS via `Product.purchase()`
    /// (or `Transaction.currentEntitlements`) — this SDK does NOT call StoreKit.
    /// On success, refreshes entitlements + credits and returns a `ReceiptResult`.
    public func postAppleReceipt(_ jws: String, productId: String) async throws -> ReceiptResult {
        Self.emit(LogEntry(level: "info", message: "postAppleReceipt"))
        do {
            let result = try await dispatcher.run { [core] in
                do {
                    return try core.postAppleReceipt(receipt: jws, productId: productId)
                } catch let err as RovenueError {
                    throw mapError(err)
                }
            }
            Self.emit(LogEntry(level: "info", message: "postAppleReceipt ok"))
            return result
        } catch {
            Self.emit(LogEntry(level: "error", message: "postAppleReceipt failed: \(error.localizedDescription)"))
            throw error
        }
    }

    /// Post a Google Play Billing purchase token to the server for validation.
    /// The caller obtains the token via `Purchase.purchaseToken` after a
    /// successful Play Billing flow on Android. (Provided here for completeness
    /// — Swift code on iOS won't use this method.)
    /// On success, refreshes entitlements + credits and returns a `ReceiptResult`.
    public func postGoogleReceipt(_ receipt: String, productId: String) async throws -> ReceiptResult {
        Self.emit(LogEntry(level: "info", message: "postGoogleReceipt"))
        do {
            let result = try await dispatcher.run { [core] in
                do {
                    return try core.postGoogleReceipt(receipt: receipt, productId: productId)
                } catch let err as RovenueError {
                    throw mapError(err)
                }
            }
            Self.emit(LogEntry(level: "info", message: "postGoogleReceipt ok"))
            return result
        } catch {
            Self.emit(LogEntry(level: "error", message: "postGoogleReceipt failed: \(error.localizedDescription)"))
            throw error
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
