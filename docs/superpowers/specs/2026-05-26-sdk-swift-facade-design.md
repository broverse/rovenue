# SDK M3 — Swift Façade Design

## Overview

Idiomatic Swift wrapper around the Rovenue Rust core (librovenue). The façade is a **thin wrapper**: it converts the blocking, UniFFI-generated Rust API into modern Swift (async/await + AsyncStream) without taking on StoreKit 2 integration. The consuming iOS/macOS app continues to own its `Product.purchase()` flow and hands the resulting JWS to `Rovenue.shared.postAppleReceipt(_:productId:)`.

This spec covers the Swift façade only. Kotlin and React Native façades follow in separate plans.

## Goals

- Public API that feels native to Swift developers (async/await, AsyncStream, structured errors).
- Singleton lifecycle matching the RevenueCat / Adapty pattern (`Rovenue.configure(...)` + `Rovenue.shared`).
- Single multiplexed `AsyncStream<RovenueChangeEvent>` for cache-change notifications.
- One-to-one mapping of Rust `RovenueError` variants to a public Swift `RovenueError` enum.
- Swift Package Manager only — SPM is the default for Apple ecosystem in 2024+.
- iOS 14 / macOS 12 minimum (Swift 5.5 async/await baseline).

## Non-Goals

- **StoreKit 2 integration.** No `Rovenue.shared.purchase(productId:)`, no `Product.products(identifiers:)`, no `Transaction.updates` listener. Consumer-app code drives StoreKit; the façade only accepts the resulting JWS via `postAppleReceipt`.
- **Restore purchases.** `restorePurchases()` would need to read `Transaction.currentEntitlements` and post each — defer to a later "Swift StoreKit integration" plan.
- **Combine `Publisher`.** Only `AsyncStream`. Combine users can `.values` on a `Publisher`-shaped wrapper later if needed.
- **CocoaPods.** SPM only for M3. Add CocoaPods if a meaningful consumer demands it.
- **End-to-end HTTP tests at the Swift layer.** Rust core has 88 mockito-driven tests covering the wire contract; the Swift layer's tests focus on the wrapping logic (error mapping, observer multiplex, configuration lifecycle). E2E coverage is deferred to a separate testing plan that introduces a mock-server harness.
- **Multi-tenant `Rovenue` instances.** Singleton-only for M3. Hybrid pattern can land later if a real use case appears.

## Public API Surface

### `Rovenue` class

```swift
public final class Rovenue: @unchecked Sendable {
  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------
  public static func configure(apiKey: String, baseUrl: String, debug: Bool = false) throws
  public static var shared: Rovenue { get } // fatalError if configure() wasn't called

  // -------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------
  public func currentUser() async throws -> User
  public func identify(_ knownUserId: String) async throws

  // -------------------------------------------------------------------
  // Entitlements (cache-first reads; refresh hits HTTP)
  // -------------------------------------------------------------------
  public func entitlement(_ id: String) async -> Entitlement?
  public func entitlementsAll() async -> [Entitlement]
  public func refreshEntitlements() async throws

  // -------------------------------------------------------------------
  // Credits (cache-first balance; consume mutates server-side)
  // -------------------------------------------------------------------
  public func creditBalance() async -> Int64
  public func refreshCredits() async throws
  public func consumeCredits(_ amount: Int64, description: String? = nil) async throws -> Int64

  // -------------------------------------------------------------------
  // Receipts (caller supplies JWS / purchase token from StoreKit / Play Billing)
  // -------------------------------------------------------------------
  public func postAppleReceipt(_ jws: String, productId: String) async throws -> ReceiptResult
  public func postGoogleReceipt(_ receipt: String, productId: String) async throws -> ReceiptResult

  // -------------------------------------------------------------------
  // Lifecycle hooks (forwarded straight to Rust core, no dispatcher)
  // -------------------------------------------------------------------
  public func setForeground(_ foreground: Bool)
  public func shutdown()

  // -------------------------------------------------------------------
  // Observer
  // -------------------------------------------------------------------
  public var changes: AsyncStream<RovenueChangeEvent> { get }
}
```

### Public types

```swift
public struct User: Sendable, Equatable {
  public let anonId: String
  public let knownUserId: String?
}

public struct Entitlement: Sendable, Equatable {
  public let id: String
  public let isActive: Bool
  public let productIdentifier: String
  public let store: String
  public let expiresIso: String?
}

public struct ReceiptResult: Sendable, Equatable {
  public let subscriberId: String
  public let appUserId: String
  public let creditBalance: Int64
}

public enum RovenueChangeEvent: Sendable, Equatable {
  case entitlementsChanged
  case identityChanged
  case creditBalanceChanged
}
```

### Errors

```swift
public enum RovenueError: Error, Equatable, Sendable, LocalizedError {
  case notConfigured
  case invalidApiKey
  case serverError
  case networkUnavailable
  case timeout
  case rateLimited
  case storage
  case userNotFound
  case insufficientCredits
  case entitlementInactive
  case duplicatePurchase
  case receiptInvalid
  case internalError

  public var errorDescription: String? { /* per-case human-readable text */ }
}
```

### Configuration lifecycle

- `configure()` validates the api key (non-empty after trim) and stores a single shared instance via an internal lock.
- Calling `configure()` a second time **replaces** the shared instance (last-write-wins). Matches RevenueCat's `Purchases.configure()` semantics; allows test setup with different keys per test.
- `Rovenue.shared` before `configure()` triggers `fatalError("Rovenue: must call configure() before accessing shared")`. The fatal-error is intentional: silent fallback would mask developer mistakes.

## Architecture

### Package layout

```
packages/sdk-swift/
├── Package.swift
├── Sources/Rovenue/
│   ├── Rovenue.swift           # public singleton class (façade entry)
│   ├── Internal/
│   │   ├── Dispatcher.swift    # blocking-call → async bridge
│   │   ├── ObserverBridge.swift # multiplexer behind .changes stream
│   │   └── TypeMappers.swift   # generated → public type conversion
│   ├── Types.swift             # User / Entitlement / ReceiptResult / RovenueChangeEvent
│   ├── Errors.swift            # RovenueError enum + mapping function
│   └── Generated/              # UniFFI auto-gen (gitignored; regen via build-bindings.sh)
└── Tests/RovenueTests/
    ├── RovenueTests.swift          # M0 smoke (preserved)
    ├── ErrorMappingTests.swift     # exhaustive Rust variant → Swift case
    ├── ConfigurationTests.swift    # configure validation + reconfigure
    └── ObserverBridgeTests.swift   # AsyncStream multiplex + cancellation
```

### Threading model

Rust core methods (UniFFI-generated `RovenueCore.*`) are **blocking**. Each public Swift async method dispatches the underlying call through a single internal serial `DispatchQueue` (`Dispatcher.swift`), then resumes via `withCheckedThrowingContinuation`.

```swift
internal final class Dispatcher {
  private let queue = DispatchQueue(label: "dev.rovenue.sdk", qos: .userInitiated)

  func run<T>(_ block: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do {
          continuation.resume(returning: try block())
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }
}
```

Decisions:
- **Single serial queue.** Rust core is already thread-safe (`Arc<Mutex<…>>`). A serial Swift-side queue avoids any contention escalation and keeps reasoning about request order simple.
- **`qos: .userInitiated`.** Reads are mostly UI-triggered (`creditBalance()` from a SwiftUI view); user-initiated priority matches.
- **`setForeground` and `shutdown` bypass the dispatcher.** Both are fire-and-forget; they only flip an atomic flag on the Rust side. Dispatching would add no value and risk shutdown-during-shutdown deadlocks.
- **`changes` is not async.** It returns an `AsyncStream` synchronously; consumption is via `for await`. The stream's internal yields happen on the Rust observer-callback thread, which UniFFI marshals back through `@Sendable` boundaries.

### Observer bridge

```swift
internal final class ObserverBridge: Observer {
  private let lock = NSLock()
  private var continuations: [UUID: AsyncStream<RovenueChangeEvent>.Continuation] = [:]

  // Called by UniFFI on the Rust observer thread.
  func onChange(event: GeneratedChangeEvent) {
    let mapped = mapEvent(event)
    lock.withLock {
      for c in continuations.values { c.yield(mapped) }
    }
  }

  func subscribe() -> AsyncStream<RovenueChangeEvent> {
    AsyncStream { continuation in
      let id = UUID()
      lock.withLock { continuations[id] = continuation }
      continuation.onTermination = { [weak self] _ in
        self?.lock.withLock { _ = self?.continuations.removeValue(forKey: id) }
      }
    }
  }
}
```

Decisions:
- **Multiplexer for multiple subscribers.** Each `for await event in rovenue.changes` opens its own continuation in the table.
- **`UUID` keyed map for O(1) deregistration on cancel.**
- **Single `Observer` registered with the Rust core** at `configure()` time, regardless of how many Swift subscribers exist. The Rust side never sees the multiplex.
- **No event buffering policy.** Default `AsyncStream` buffering policy applies (`unbounded`). Future tuning if profiling shows backpressure problems.

### Type mapping

UniFFI generates `User`, `Entitlement`, `ReceiptResult`, `ChangeEvent`, `Config` directly. The façade introduces parallel public types (`User`, `Entitlement`, `ReceiptResult`, `RovenueChangeEvent`) to:
- Apply idiomatic Swift naming (`anonId` vs UniFFI's `anonId` — already camelCase, but explicit re-shape future-proofs renames).
- Stamp `Sendable + Equatable` conformance which UniFFI's generated types don't always carry.
- Decouple the public API from any UDL-level renames over time.

The mapping is mechanical and lives in `TypeMappers.swift` — one function per type.

### Error mapping

Every Rust `RovenueError` variant maps to exactly one Swift `RovenueError` case. The mapping function is exhaustively switched so a future Rust-side variant addition causes a compile error in the Swift façade (catching the gap at build time).

```swift
internal func mapError(_ generated: GeneratedRovenueError) -> RovenueError {
  switch generated {
  case .NotConfigured:         return .notConfigured
  case .InvalidApiKey:         return .invalidApiKey
  case .ServerError:           return .serverError
  case .NetworkUnavailable:    return .networkUnavailable
  case .Timeout:               return .timeout
  case .RateLimited:           return .rateLimited
  case .Storage:               return .storage
  case .UserNotFound:          return .userNotFound
  case .InsufficientCredits:   return .insufficientCredits
  case .EntitlementInactive:   return .entitlementInactive
  case .DuplicatePurchase:     return .duplicatePurchase
  case .ReceiptInvalid:        return .receiptInvalid
  case .Internal:              return .internalError
  }
}
```

## Testing

| Test file | What it covers |
|---|---|
| `RovenueTests.swift` | M0 smoke preserved: `Rovenue.version == "0.0.1"` |
| `ErrorMappingTests.swift` | Each of 13 Rust variants maps to expected Swift case; exhaustive switch catches future drift at compile time |
| `ConfigurationTests.swift` | `configure` rejects empty / whitespace api key (throws `RovenueError.invalidApiKey`); calling `configure` twice replaces the shared instance; documenting fatalError for pre-configure `shared` access |
| `ObserverBridgeTests.swift` | Subscribe + manual emit yields the event on the consumer side; two parallel `for await` loops both receive every event; cancelling one removes only that continuation from the table |
| `TypeMapperTests.swift` | Generated → public type field-by-field roundtrips |

Tests run via SPM: `swift test --package-path packages/sdk-swift`. Existing `scripts/sdk-parity.sh` already invokes this in CI; we'll add the new test files via `XCTest` defaults — no script change needed.

E2E tests against a real (or mocked) Rovenue server are **out of scope** for M3. The Rust crate's 88 mockito-driven tests already prove the wire contract. Swift-layer integration tests would require a mockable HTTP layer that doesn't exist in the Rust core (HttpClient is private to the crate), so they belong in a separate testing-infra plan.

## Distribution

- **Swift Package Manager only.** `Package.swift` from M0 already declares the package; M3 adds the new source files into the same target.
- **Minimum platforms:** iOS 14, macOS 12 (matches `Package.swift`).
- **Binary linkage:** `librovenue.a` static library produced by `./packages/core-rs/scripts/build-bindings.sh` and linked via SPM's `systemLibrary` / `binaryTarget` (the exact mechanism already wired by M0; M3 verifies it still resolves after the façade additions).
- **Versioning:** the façade ships in lockstep with the Rust core's `SDK_VERSION` constant. `Rovenue.version` returns the same string.

## Open Questions / Future Work

- **StoreKit 2 integration** — own plan once thin wrapper is shipped and a real iOS sample app exists to validate the consumer ergonomics.
- **Combine bridge** — likely as a thin computed property that returns `changes.values.eraseToAnyPublisher()`. Defer until a Combine-only consumer surfaces.
- **Async sequence over individual entitlements / credits** — separate per-resource streams (`rovenue.entitlements.changes`) — convenience sugar over `changes.filter(_:)`. Defer; the single stream covers the use cases.
- **Macros / `@Observable` integration** — Swift 5.9 Observation macro could replace `AsyncStream` for SwiftUI consumers. Defer until ecosystem adoption is broader.
- **Mock infrastructure for end-to-end tests** — needs a Rust-side trait abstraction over `HttpClient` (or a recompile flag to swap reqwest for a mock transport). Separate plan.

## References

- M1 plan: `docs/superpowers/plans/2026-05-26-sdk-m1-rust-core.md` — landed `Observer` protocol + `RovenueCore` FFI surface.
- M2 plan: `docs/superpowers/plans/2026-05-26-sdk-m2-receipts-credits-idempotency.md` — landed `postAppleReceipt`, `postGoogleReceipt`, `consumeCredits`, `creditBalance`, `ChangeEvent::CreditBalanceChanged`.
- Memory: `rovenue_sdk_architecture.md` — confirms Rust-core + native-façade architecture.
- RevenueCat Purchases SDK (Swift) — pattern reference for `configure` + `shared` lifecycle.

---

*End of spec.*
