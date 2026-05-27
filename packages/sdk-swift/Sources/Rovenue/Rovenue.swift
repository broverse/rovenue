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
}
