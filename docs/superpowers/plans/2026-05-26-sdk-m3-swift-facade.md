# SDK M3 — Swift Façade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the M3 milestone — an idiomatic Swift façade over the UniFFI-generated Rovenue Rust core. Singleton `Rovenue.shared`, async/await methods bridged via a serial `DispatchQueue`, single multiplexed `AsyncStream<ChangeEvent>` for observer events, and a public `Rovenue.Error` enum that maps exhaustively from the generated `RovenueError`.

**Architecture:** Final class + async methods (not actor) so the singleton lifecycle is natural and the Rust core's own `Arc<Mutex<…>>` synchronization isn't doubled. Each public async method dispatches the blocking Rust call through one internal serial `DispatchQueue`, resuming via `withCheckedThrowingContinuation`. The internal `ObserverBridge` implements the UniFFI-generated `Observer` protocol once at `configure()` time and multiplexes every emit into all active `AsyncStream` continuations keyed by `UUID`.

**Tech Stack:** Swift 5.9+ (Package.swift declares `swift-tools-version: 5.9`), XCTest, SPM only. No new external Swift deps. Rust core (M2-shipped) is the source of all behavior.

**Deviation from spec — name-collision fix:** The spec proposed parallel public structs (`User`, `Entitlement`, `ReceiptResult`, `RovenueChangeEvent`). The generated UniFFI binding ALREADY declares `public struct User`, `public struct Entitlement`, `public struct ReceiptResult`, `public enum ChangeEvent` in the same `Rovenue` Swift module — duplicates are a build error. We resolve by **using the generated types directly and adding `Sendable + Equatable` conformance via `extension`**. The error type alone gets a public Swift renaming (`Rovenue.Error` as a nested enum) because the generated `RovenueError` cases carry an associated `message: String` and use PascalCase, which is non-idiomatic Swift. This deviation actually serves the spec's "thin wrapper" intent better: zero mapping overhead for value types, idiomatic error surface for the one type that needs reshaping.

**Non-goals (re-confirmed from spec):** StoreKit 2 integration, restore_purchases, Combine `Publisher`, CocoaPods, multi-tenant instances, end-to-end HTTP tests at the Swift layer (deferred to a later infra plan).

---

## File Structure

**New crate files under `packages/sdk-swift/Sources/Rovenue/`:**

- `Rovenue.swift` — public singleton class (replaces the M0 placeholder `RovenueModule` enum)
- `Errors.swift` — `Rovenue.Error` nested enum + internal `mapError(_:)` function
- `Types.swift` — `Sendable + Equatable` extensions for generated `User`, `Entitlement`, `ReceiptResult`, `ChangeEvent`
- `Internal/Dispatcher.swift` — blocking-call → async bridge (serial DispatchQueue)
- `Internal/ObserverBridge.swift` — multiplexer behind the public `changes` stream

**Modified files:**

- `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` — replaces the M0 placeholder file. The new content lives at the same path. Existing `RovenueModule.version` static is removed.
- `packages/sdk-swift/Tests/RovenueTests/RovenueTests.swift` — preserved as the M0 smoke test, but updated to also call `Rovenue.configure(...)` + `Rovenue.shared.version` (so the M0 promise survives the API rewrite).

**New tests:**

- `packages/sdk-swift/Tests/RovenueTests/ErrorMappingTests.swift`
- `packages/sdk-swift/Tests/RovenueTests/ConfigurationTests.swift`
- `packages/sdk-swift/Tests/RovenueTests/ObserverBridgeTests.swift`

---

## Conventions

- **All public Swift methods that hit the Rust core are `async throws`** (or `async` for non-throwing reads). They dispatch through `Dispatcher.run(_:)` to the serial queue.
- **`setForeground` and `shutdown` are sync** — they only flip an atomic flag on the Rust side. Dispatching adds no value.
- **`Rovenue.version` is sync** — calls the free function `sdkVersion()` which returns a static constant.
- **TDD per task** — failing XCTest first, then implementation.
- **Tests run via** `swift test --package-path packages/sdk-swift` OR `cd packages/sdk-swift && swift test`. Use the former from the repo root.
- **The generated `RovenueFFI.swift` is gitignored** — every fresh checkout regenerates via `./packages/core-rs/scripts/build-bindings.sh`. The plan's first task verifies the regen.
- **Existing M0 baseline:** `RovenueModule.version` (placeholder) + 3 smoke tests in `RovenueTests.swift`. The plan replaces the placeholder and grows the smoke set.
- **No new external Swift packages.** Everything is built-in (`Foundation`, `XCTest`, `DispatchQueue`, `AsyncStream`).

---

## Task 1: Verify bindings regenerate + M0 baseline green

**Files:**
- Verify only — no edits.

This task confirms the workspace is in a buildable state before we start adding façade code.

- [ ] **Step 1.1: Regenerate bindings**

```bash
source $HOME/.cargo/env && ./packages/core-rs/scripts/build-bindings.sh
```
Expected: `✓ bindings generated`. Both `RovenueFFI.swift` and `librovenue.kt` are present.

- [ ] **Step 1.2: Confirm Swift M0 smoke passes**

```bash
cd packages/sdk-swift && swift test 2>&1 | tail -10
```
Expected: 3 tests pass (`test_getVersion_matchesCargoPkgVersion`, `test_invalidApiKey_throws`, `test_sdkVersionFreeFunction`).

If `swift` isn't on PATH locally, that's OK — note the skip and proceed. CI has Swift.

- [ ] **Step 1.3: Confirm the generated public types look as expected**

```bash
grep -nE '^public (struct|enum|protocol|class) [A-Z]' packages/sdk-swift/Sources/Rovenue/Generated/RovenueFFI.swift | head -15
```
Expected output includes:
```
public protocol RovenueCoreProtocol
public class RovenueCore: RovenueCoreProtocol
public struct Config
public struct Entitlement
public struct ReceiptResult
public struct User
public enum ChangeEvent
public enum RovenueError
public protocol Observer : AnyObject
```

If `ChangeEvent` or `Observer` are missing, the bindings didn't regenerate cleanly. Re-run Step 1.1.

- [ ] **Step 1.4: No commit** — this is a verification-only task.

---

## Task 2: Sendable + Equatable extensions for generated types

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/Types.swift`

The generated `User`, `Entitlement`, `ReceiptResult`, `ChangeEvent` declare their stored properties but don't conform to `Sendable + Equatable`. We add those conformances via extension so SwiftUI / Combine consumers can pass these values across actors and use `XCTAssertEqual`.

No test file in this task — these extensions are leaf code with no behavior to assert beyond "compiles and the conformance exists." We exercise them implicitly in later tests (`Equatable` is needed by `ObserverBridgeTests` to compare `[ChangeEvent]`).

- [ ] **Step 2.1: Create the file**

Create `packages/sdk-swift/Sources/Rovenue/Types.swift`:

```swift
//  Types.swift — Sendable + Equatable conformance for UniFFI-generated value types.
//
//  The generated `User`, `Entitlement`, `ReceiptResult`, and `ChangeEvent`
//  declare their stored properties but don't carry these protocol conformances.
//  Swift can synthesize them automatically once we declare the extension — all
//  stored properties are themselves `Sendable` (primitives or other generated
//  types we extend the same way) and `Equatable`.
//
//  Adding these here keeps the public API surface idiomatic without forcing
//  the UDL to declare conformance traits (UniFFI 0.25 doesn't expose that
//  knob anyway).

import Foundation

extension User: @unchecked Sendable, Equatable {
    public static func == (lhs: User, rhs: User) -> Bool {
        lhs.anonId == rhs.anonId && lhs.knownUserId == rhs.knownUserId
    }
}

extension Entitlement: @unchecked Sendable, Equatable {
    public static func == (lhs: Entitlement, rhs: Entitlement) -> Bool {
        lhs.id == rhs.id
            && lhs.isActive == rhs.isActive
            && lhs.productIdentifier == rhs.productIdentifier
            && lhs.store == rhs.store
            && lhs.expiresIso == rhs.expiresIso
    }
}

extension ReceiptResult: @unchecked Sendable, Equatable {
    public static func == (lhs: ReceiptResult, rhs: ReceiptResult) -> Bool {
        lhs.subscriberId == rhs.subscriberId
            && lhs.appUserId == rhs.appUserId
            && lhs.creditBalance == rhs.creditBalance
    }
}

extension ChangeEvent: @unchecked Sendable, Equatable {
    public static func == (lhs: ChangeEvent, rhs: ChangeEvent) -> Bool {
        switch (lhs, rhs) {
        case (.entitlementsChanged, .entitlementsChanged): return true
        case (.identityChanged, .identityChanged): return true
        case (.creditBalanceChanged, .creditBalanceChanged): return true
        default: return false
        }
    }
}
```

`@unchecked Sendable` is the pragmatic choice because UniFFI's generated structs hold `String`/`Int64`/`Bool`/`Optional<…>` only — all are `Sendable` — but the compiler can't synthesize the conformance automatically since the structs are defined in another file we don't own. The explicit `==` implementations side-step Swift's "synthesized Equatable must be in the same file as the struct declaration" rule.

- [ ] **Step 2.2: Verify the package builds**

```bash
cd packages/sdk-swift && swift build 2>&1 | tail -5
```
Expected: build succeeds with no warnings.

If `swift` isn't on PATH, skip and proceed — later tests will catch any conformance issues.

- [ ] **Step 2.3: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Types.swift
git commit -m "feat(sdk-swift): Sendable + Equatable for User/Entitlement/ReceiptResult/ChangeEvent"
```

---

## Task 3: `Rovenue.Error` enum + mapError function

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/Errors.swift`
- Create: `packages/sdk-swift/Tests/RovenueTests/ErrorMappingTests.swift`

The generated `RovenueError` cases use PascalCase (`InvalidApiKey`) and carry an associated `message: String`. The public Swift API drops the message (it's already in the error description / log) and uses camelCase per Swift convention. We resolve the name collision by nesting our enum as `Rovenue.Error`.

- [ ] **Step 3.1: Write the failing test**

Create `packages/sdk-swift/Tests/RovenueTests/ErrorMappingTests.swift`:

```swift
import XCTest
@testable import Rovenue

final class ErrorMappingTests: XCTestCase {
    func test_mapError_NotConfigured() {
        XCTAssertEqual(mapError(.NotConfigured(message: "x")), .notConfigured)
    }

    func test_mapError_InvalidApiKey() {
        XCTAssertEqual(mapError(.InvalidApiKey(message: "x")), .invalidApiKey)
    }

    func test_mapError_ServerError() {
        XCTAssertEqual(mapError(.ServerError(message: "x")), .serverError)
    }

    func test_mapError_NetworkUnavailable() {
        XCTAssertEqual(mapError(.NetworkUnavailable(message: "x")), .networkUnavailable)
    }

    func test_mapError_Timeout() {
        XCTAssertEqual(mapError(.Timeout(message: "x")), .timeout)
    }

    func test_mapError_RateLimited() {
        XCTAssertEqual(mapError(.RateLimited(message: "x")), .rateLimited)
    }

    func test_mapError_Storage() {
        XCTAssertEqual(mapError(.Storage(message: "x")), .storage)
    }

    func test_mapError_UserNotFound() {
        XCTAssertEqual(mapError(.UserNotFound(message: "x")), .userNotFound)
    }

    func test_mapError_InsufficientCredits() {
        XCTAssertEqual(mapError(.InsufficientCredits(message: "x")), .insufficientCredits)
    }

    func test_mapError_EntitlementInactive() {
        XCTAssertEqual(mapError(.EntitlementInactive(message: "x")), .entitlementInactive)
    }

    func test_mapError_DuplicatePurchase() {
        XCTAssertEqual(mapError(.DuplicatePurchase(message: "x")), .duplicatePurchase)
    }

    func test_mapError_ReceiptInvalid() {
        XCTAssertEqual(mapError(.ReceiptInvalid(message: "x")), .receiptInvalid)
    }

    func test_mapError_Internal() {
        XCTAssertEqual(mapError(.Internal(message: "x")), .internalError)
    }

    func test_errorDescription_isHumanReadable() {
        // Every case has a non-empty description for debugging.
        let cases: [Rovenue.Error] = [
            .notConfigured, .invalidApiKey, .serverError, .networkUnavailable,
            .timeout, .rateLimited, .storage, .userNotFound, .insufficientCredits,
            .entitlementInactive, .duplicatePurchase, .receiptInvalid, .internalError,
        ]
        for c in cases {
            XCTAssertFalse(c.errorDescription?.isEmpty ?? true, "\(c) has empty description")
        }
    }
}
```

- [ ] **Step 3.2: Run, see failure**

```bash
cd packages/sdk-swift && swift test --filter ErrorMappingTests 2>&1 | tail -10
```
Expected: FAIL — `Rovenue.Error`, `mapError` not defined.

- [ ] **Step 3.3: Create `packages/sdk-swift/Sources/Rovenue/Errors.swift`**

```swift
//  Errors.swift — public Swift error surface for the Rovenue façade.
//
//  Wraps the UniFFI-generated `RovenueError` (which carries `(message: String)`
//  on every case and uses PascalCase) as a flat camelCase Swift enum. The
//  associated message is dropped from the public type but appears in
//  `errorDescription` so consumers can surface it to logs / UI.

import Foundation

public extension Rovenue {
    enum Error: Swift.Error, Equatable, Sendable, LocalizedError {
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

        public var errorDescription: String? {
            switch self {
            case .notConfigured:
                return "Rovenue.configure() must be called before accessing Rovenue.shared"
            case .invalidApiKey:
                return "API key is missing or invalid"
            case .serverError:
                return "Server returned an error"
            case .networkUnavailable:
                return "Network is unavailable"
            case .timeout:
                return "Request timed out"
            case .rateLimited:
                return "Rate limit exceeded"
            case .storage:
                return "Local storage error"
            case .userNotFound:
                return "User not found"
            case .insufficientCredits:
                return "Insufficient credits for this operation"
            case .entitlementInactive:
                return "Entitlement is inactive"
            case .duplicatePurchase:
                return "Purchase already recorded"
            case .receiptInvalid:
                return "Receipt could not be validated"
            case .internalError:
                return "Internal SDK error"
            }
        }
    }
}

/// Maps the UniFFI-generated `RovenueError` to the public `Rovenue.Error`.
/// Exhaustively switched: any future Rust-side variant addition causes a
/// compile error here, surfacing the gap at build time rather than runtime.
internal func mapError(_ generated: RovenueError) -> Rovenue.Error {
    switch generated {
    case .NotConfigured:        return .notConfigured
    case .InvalidApiKey:        return .invalidApiKey
    case .ServerError:          return .serverError
    case .NetworkUnavailable:   return .networkUnavailable
    case .Timeout:              return .timeout
    case .RateLimited:          return .rateLimited
    case .Storage:              return .storage
    case .UserNotFound:         return .userNotFound
    case .InsufficientCredits:  return .insufficientCredits
    case .EntitlementInactive:  return .entitlementInactive
    case .DuplicatePurchase:    return .duplicatePurchase
    case .ReceiptInvalid:       return .receiptInvalid
    case .Internal:             return .internalError
    }
}
```

NOTE: this file references `Rovenue` (the class), which doesn't exist yet — only its name will resolve in a later task. The `public extension Rovenue { … }` is a *forward declaration* of a nested type and needs `Rovenue` to be defined somewhere in the module. We add a stub now in Step 3.4 and replace it in Task 6.

- [ ] **Step 3.4: Add a stub Rovenue class so the extension resolves**

Create `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`:

```swift
//  Rovenue.swift — public singleton façade entry point.
//  Filled out by later tasks; this stub exists so `Rovenue.Error` (in Errors.swift)
//  has a host type to nest under.

import Foundation

public final class Rovenue: @unchecked Sendable {
    // Intentionally empty for Task 3. Lifecycle + methods land in later tasks.
}
```

This stub replaces the M0 `Rovenue.swift` (which exposed `RovenueModule.version`). The M0 smoke test (`test_sdkVersionFreeFunction`) still passes because it calls the top-level `sdkVersion()` free function from the generated file, not anything on the façade.

NOTE: `test_getVersion_matchesCargoPkgVersion` and `test_invalidApiKey_throws` in `RovenueTests.swift` use the generated `RovenueCore` and `Config` directly — they continue to pass against the unchanged generated file. We do NOT modify `RovenueTests.swift` in this task; Task 12 updates it.

- [ ] **Step 3.5: Run tests**

```bash
cd packages/sdk-swift && swift test --filter ErrorMappingTests 2>&1 | tail -10
```
Expected: 14 tests pass.

```bash
cd packages/sdk-swift && swift test 2>&1 | tail -5
```
Expected: all M0 tests still pass; 14 new error-mapping tests pass.

- [ ] **Step 3.6: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Errors.swift packages/sdk-swift/Sources/Rovenue/Rovenue.swift packages/sdk-swift/Tests/RovenueTests/ErrorMappingTests.swift
git commit -m "feat(sdk-swift): Rovenue.Error nested enum + exhaustive RovenueError mapping"
```

---

## Task 4: Internal `Dispatcher` — blocking → async bridge

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/Internal/Dispatcher.swift`

No tests in this task — `Dispatcher` is leaf infrastructure. It gets exercised implicitly by every later async method test.

- [ ] **Step 4.1: Create the file**

Create `packages/sdk-swift/Sources/Rovenue/Internal/Dispatcher.swift`:

```swift
//  Dispatcher.swift — bridges blocking Rust-core calls into Swift async/await.
//
//  Every public async method on `Rovenue` that hits the Rust core flows through
//  this dispatcher. The Rust core's methods are synchronous (per the UniFFI
//  spec we picked in M1), so calling them on @MainActor would block the UI.
//  The dispatcher serializes them on a single user-initiated queue and
//  resumes the calling task via withCheckedThrowingContinuation.

import Foundation

internal final class Dispatcher: @unchecked Sendable {
    private let queue: DispatchQueue

    init(label: String = "dev.rovenue.sdk") {
        self.queue = DispatchQueue(label: label, qos: .userInitiated)
    }

    /// Run a throwing block on the dispatcher's serial queue and await its result.
    func run<T>(_ block: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Swift.Error>) in
            queue.async {
                do {
                    continuation.resume(returning: try block())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Run a non-throwing block on the dispatcher's serial queue and await its result.
    func runNonThrowing<T>(_ block: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { (continuation: CheckedContinuation<T, Never>) in
            queue.async {
                continuation.resume(returning: block())
            }
        }
    }
}
```

- [ ] **Step 4.2: Verify build**

```bash
cd packages/sdk-swift && swift build 2>&1 | tail -5
```
Expected: clean build.

- [ ] **Step 4.3: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Internal/Dispatcher.swift
git commit -m "feat(sdk-swift): Dispatcher — serial queue async bridge over blocking Rust core"
```

---

## Task 5: Internal `ObserverBridge` + tests

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/Internal/ObserverBridge.swift`
- Create: `packages/sdk-swift/Tests/RovenueTests/ObserverBridgeTests.swift`

The bridge implements the UniFFI-generated `Observer` protocol once and multiplexes every `onChange` callback into all active `AsyncStream` continuations. Each call to `subscribe()` returns a new stream and registers a fresh continuation in the table; cancellation removes it.

- [ ] **Step 5.1: Write the failing test**

Create `packages/sdk-swift/Tests/RovenueTests/ObserverBridgeTests.swift`:

```swift
import XCTest
@testable import Rovenue

final class ObserverBridgeTests: XCTestCase {
    func test_subscribe_receivesEmittedEvent() async {
        let bridge = ObserverBridge()
        let stream = bridge.subscribe()
        bridge.onChange(event: .entitlementsChanged)

        var iterator = stream.makeAsyncIterator()
        let received = await iterator.next()
        XCTAssertEqual(received, .entitlementsChanged)
    }

    func test_subscribe_receivesMultipleEvents() async {
        let bridge = ObserverBridge()
        let stream = bridge.subscribe()
        bridge.onChange(event: .entitlementsChanged)
        bridge.onChange(event: .creditBalanceChanged)
        bridge.onChange(event: .identityChanged)

        var iterator = stream.makeAsyncIterator()
        let first = await iterator.next()
        let second = await iterator.next()
        let third = await iterator.next()
        XCTAssertEqual(first, .entitlementsChanged)
        XCTAssertEqual(second, .creditBalanceChanged)
        XCTAssertEqual(third, .identityChanged)
    }

    func test_twoSubscribers_bothReceiveEachEvent() async {
        let bridge = ObserverBridge()
        let a = bridge.subscribe()
        let b = bridge.subscribe()
        bridge.onChange(event: .entitlementsChanged)

        var aIter = a.makeAsyncIterator()
        var bIter = b.makeAsyncIterator()
        let aGot = await aIter.next()
        let bGot = await bIter.next()
        XCTAssertEqual(aGot, .entitlementsChanged)
        XCTAssertEqual(bGot, .entitlementsChanged)
    }

    func test_liveCount_dropsAfterStreamFinishes() async {
        let bridge = ObserverBridge()
        do {
            let stream = bridge.subscribe()
            _ = stream
            XCTAssertEqual(bridge.liveCount(), 1)
        }
        // The stream's continuation isn't terminated automatically by going out
        // of scope (AsyncStream's lifecycle is tied to consumer iteration); to
        // actually deregister we must call `finish()` from the producer side.
        // We exercise that path explicitly:
        bridge.finishAll()
        XCTAssertEqual(bridge.liveCount(), 0)
    }
}
```

- [ ] **Step 5.2: Run, see failure**

```bash
cd packages/sdk-swift && swift test --filter ObserverBridgeTests 2>&1 | tail -10
```
Expected: FAIL — `ObserverBridge` not defined.

- [ ] **Step 5.3: Create `packages/sdk-swift/Sources/Rovenue/Internal/ObserverBridge.swift`**

```swift
//  ObserverBridge.swift — multiplexer between the Rust observer callback and
//  multiple Swift AsyncStream subscribers.
//
//  Rust core's `register_observer(obs)` accepts exactly one Observer at a
//  time. To support multiple Swift consumers (each `for await event in
//  rovenue.changes` loop is its own subscriber), we register exactly one
//  ObserverBridge with the core and let the bridge fan-out emits into a
//  table of AsyncStream continuations.

import Foundation

internal final class ObserverBridge: Observer, @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [UUID: AsyncStream<ChangeEvent>.Continuation] = [:]

    /// Called by UniFFI on the Rust observer thread.
    func onChange(event: ChangeEvent) {
        lock.lock()
        let snapshot = continuations.values
        lock.unlock()
        for c in snapshot {
            c.yield(event)
        }
    }

    /// Create a fresh AsyncStream subscriber. Each call returns an independent
    /// stream; multiple subscribers may exist concurrently.
    func subscribe() -> AsyncStream<ChangeEvent> {
        AsyncStream { continuation in
            let id = UUID()
            lock.lock()
            continuations[id] = continuation
            lock.unlock()
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                self.continuations.removeValue(forKey: id)
                self.lock.unlock()
            }
        }
    }

    /// Testing hook — count of live continuations.
    func liveCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return continuations.count
    }

    /// Testing hook — finish all streams and clear the table.
    func finishAll() {
        lock.lock()
        let toFinish = Array(continuations.values)
        continuations.removeAll()
        lock.unlock()
        for c in toFinish { c.finish() }
    }
}
```

- [ ] **Step 5.4: Run tests**

```bash
cd packages/sdk-swift && swift test --filter ObserverBridgeTests 2>&1 | tail -10
```
Expected: 4 tests pass.

`cd packages/sdk-swift && swift test 2>&1 | tail -5` → 21 total green (3 M0 + 14 error + 4 observer).

- [ ] **Step 5.5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Internal/ObserverBridge.swift packages/sdk-swift/Tests/RovenueTests/ObserverBridgeTests.swift
git commit -m "feat(sdk-swift): ObserverBridge — UUID-keyed multiplex over Observer callbacks"
```

---

## Task 6: `Rovenue` class — configure / shared / version

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`
- Create: `packages/sdk-swift/Tests/RovenueTests/ConfigurationTests.swift`

Replaces the Task 3 stub with the real singleton class. `configure()` validates the api key, builds the underlying `RovenueCore`, and stores the shared instance. `shared` accessor fatalErrors if not yet configured. `version` returns `sdkVersion()`.

- [ ] **Step 6.1: Write the failing test**

Create `packages/sdk-swift/Tests/RovenueTests/ConfigurationTests.swift`:

```swift
import XCTest
@testable import Rovenue

final class ConfigurationTests: XCTestCase {
    override func setUp() {
        super.setUp()
        // Tests in this file must not assume any prior shared instance state.
        Rovenue.resetForTesting()
    }

    func test_configure_rejectsEmptyApiKey() {
        XCTAssertThrowsError(try Rovenue.configure(apiKey: "", baseUrl: "https://api.rovenue.dev")) { err in
            guard let e = err as? Rovenue.Error else { return XCTFail("expected Rovenue.Error, got \(err)") }
            XCTAssertEqual(e, .invalidApiKey)
        }
    }

    func test_configure_rejectsWhitespaceApiKey() {
        XCTAssertThrowsError(try Rovenue.configure(apiKey: "   ", baseUrl: "https://api.rovenue.dev")) { err in
            XCTAssertEqual(err as? Rovenue.Error, .invalidApiKey)
        }
    }

    func test_configure_succeedsWithValidConfig() throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        XCTAssertEqual(Rovenue.shared.version, "0.0.1")
    }

    func test_configureTwice_lastWriteWins() throws {
        try Rovenue.configure(apiKey: "pk_first", baseUrl: "https://api.rovenue.dev")
        let firstInstance = Rovenue.shared
        try Rovenue.configure(apiKey: "pk_second", baseUrl: "https://api.rovenue.dev")
        let secondInstance = Rovenue.shared
        XCTAssertFalse(firstInstance === secondInstance, "configure() should replace the shared instance")
    }
}
```

The `resetForTesting()` static method is a test-only seam (marked with `@testable` import access). Production callers never see it.

- [ ] **Step 6.2: Run, see failure**

```bash
cd packages/sdk-swift && swift test --filter ConfigurationTests 2>&1 | tail -15
```
Expected: FAIL — `Rovenue.configure`, `Rovenue.shared`, `Rovenue.resetForTesting`, `Rovenue.version` not defined.

- [ ] **Step 6.3: Replace `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`**

```swift
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
}
```

- [ ] **Step 6.4: Run tests**

```bash
cd packages/sdk-swift && swift test --filter ConfigurationTests 2>&1 | tail -15
```
Expected: 4 tests pass.

```bash
cd packages/sdk-swift && swift test 2>&1 | tail -5
```
Expected: full suite green — 25 tests (3 M0 + 14 error + 4 observer + 4 config). Note: each `ConfigurationTests` test calls `resetForTesting` in setUp, which destroys the prior cache db handle but leaves the file on disk — fine for the tests we have.

- [ ] **Step 6.5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift packages/sdk-swift/Tests/RovenueTests/ConfigurationTests.swift
git commit -m "feat(sdk-swift): Rovenue.configure + shared + version + resetForTesting"
```

---

## Task 7: Identity methods — `currentUser`, `identify`

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`

Wraps `RovenueCore.currentUser()` and `RovenueCore.identify(knownUserId:)`. The first is non-throwing (cache read), the second throws.

- [ ] **Step 7.1: Add methods to `Rovenue` class**

Edit `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`. Inside `public final class Rovenue` (before the closing `}`), add the section:

```swift
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
```

- [ ] **Step 7.2: Verify build**

```bash
cd packages/sdk-swift && swift build 2>&1 | tail -5
```
Expected: clean build.

- [ ] **Step 7.3: Smoke check that the M0 suite still passes**

```bash
cd packages/sdk-swift && swift test 2>&1 | tail -5
```
Expected: still 25 tests green (no new tests in this task; we add an integration smoke in Task 12).

- [ ] **Step 7.4: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift
git commit -m "feat(sdk-swift): Rovenue.currentUser + identify"
```

---

## Task 8: Entitlement methods — read + refresh

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`

- [ ] **Step 8.1: Add methods to `Rovenue` class**

Edit `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`. After the Identity section, add:

```swift
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
```

- [ ] **Step 8.2: Verify**

```bash
cd packages/sdk-swift && swift build 2>&1 | tail -3
cd packages/sdk-swift && swift test 2>&1 | tail -5
```
Expected: clean build, 25 tests still pass.

- [ ] **Step 8.3: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift
git commit -m "feat(sdk-swift): Rovenue.entitlement + entitlementsAll + refreshEntitlements"
```

---

## Task 9: Credit methods — balance + refresh + consume

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`

- [ ] **Step 9.1: Add methods to `Rovenue` class**

Edit `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`. After the Entitlements section, add:

```swift
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
```

- [ ] **Step 9.2: Verify**

```bash
cd packages/sdk-swift && swift build 2>&1 | tail -3
cd packages/sdk-swift && swift test 2>&1 | tail -5
```
Expected: clean build, 25 tests pass.

- [ ] **Step 9.3: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift
git commit -m "feat(sdk-swift): Rovenue.creditBalance + refreshCredits + consumeCredits"
```

---

## Task 10: Receipt methods — postAppleReceipt + postGoogleReceipt

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`

- [ ] **Step 10.1: Add methods to `Rovenue` class**

Edit `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`. After the Credits section, add:

```swift
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
```

- [ ] **Step 10.2: Verify**

```bash
cd packages/sdk-swift && swift build 2>&1 | tail -3
cd packages/sdk-swift && swift test 2>&1 | tail -5
```
Expected: clean build, 25 tests pass.

- [ ] **Step 10.3: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift
git commit -m "feat(sdk-swift): Rovenue.postAppleReceipt + postGoogleReceipt"
```

---

## Task 11: Lifecycle + Observer — setForeground, shutdown, changes stream

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`

`setForeground` and `shutdown` are sync forwards to the Rust core. `changes` is a computed property that returns a fresh `AsyncStream` per access (each consumer gets its own multiplexed subscription).

- [ ] **Step 11.1: Add methods + property to `Rovenue` class**

Edit `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`. After the Receipts section, add:

```swift
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
```

- [ ] **Step 11.2: Verify**

```bash
cd packages/sdk-swift && swift build 2>&1 | tail -3
cd packages/sdk-swift && swift test 2>&1 | tail -5
```
Expected: clean build, 25 tests still pass.

- [ ] **Step 11.3: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Rovenue.swift
git commit -m "feat(sdk-swift): Rovenue.setForeground + shutdown + changes stream"
```

---

## Task 12: Update M0 smoke test to exercise the new singleton

**Files:**
- Modify: `packages/sdk-swift/Tests/RovenueTests/RovenueTests.swift`

The M0 smoke tested `RovenueCore` directly. With the new façade in place, we want a smoke that uses the public `Rovenue.shared` API end-to-end (for whatever doesn't require a live server). The existing tests stay — they continue to prove the generated bindings work — and we add 2 new smoke tests for the façade entry.

- [ ] **Step 12.1: Append new smoke tests**

Edit `packages/sdk-swift/Tests/RovenueTests/RovenueTests.swift`. Replace its full contents with:

```swift
import XCTest
@testable import Rovenue

final class RovenueTests: XCTestCase {
    // -----------------------------------------------------------------
    // M0 smoke (generated bindings — preserved for parity)
    // -----------------------------------------------------------------

    func test_getVersion_matchesCargoPkgVersion() throws {
        let cfg = Config(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev", debug: false)
        let core = try RovenueCore(config: cfg)
        XCTAssertFalse(core.getVersion().isEmpty)
        XCTAssertEqual(core.getVersion(), "0.0.1")
    }

    func test_invalidApiKey_throws_atGeneratedLayer() {
        let cfg = Config(apiKey: "", baseUrl: "https://api.rovenue.dev", debug: false)
        XCTAssertThrowsError(try RovenueCore(config: cfg)) { err in
            guard case RovenueError.InvalidApiKey = err else {
                return XCTFail("expected InvalidApiKey, got \(err)")
            }
        }
    }

    func test_sdkVersionFreeFunction() {
        XCTAssertEqual(sdkVersion(), "0.0.1")
    }

    // -----------------------------------------------------------------
    // M3 façade smoke (public Rovenue.shared API)
    // -----------------------------------------------------------------

    override func setUp() {
        super.setUp()
        Rovenue.resetForTesting()
    }

    func test_facade_versionMatchesGenerated() throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        XCTAssertEqual(Rovenue.shared.version, sdkVersion())
    }

    func test_facade_currentUserHasAnonId() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        let user = await Rovenue.shared.currentUser()
        XCTAssertTrue(user.anonId.hasPrefix("anon_"))
        XCTAssertNil(user.knownUserId)
    }

    func test_facade_entitlementsEmpty() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        let pro = await Rovenue.shared.entitlement("pro")
        XCTAssertNil(pro)
        let all = await Rovenue.shared.entitlementsAll()
        XCTAssertTrue(all.isEmpty)
    }

    func test_facade_creditBalanceZeroByDefault() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        let balance = await Rovenue.shared.creditBalance()
        XCTAssertEqual(balance, 0)
    }

    func test_facade_identifyEmitsChange() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        let stream = Rovenue.shared.changes
        var iterator = stream.makeAsyncIterator()
        try await Rovenue.shared.identify("user_42")
        let event = await iterator.next()
        XCTAssertEqual(event, .identityChanged)
        let user = await Rovenue.shared.currentUser()
        XCTAssertEqual(user.knownUserId, "user_42")
    }
}
```

- [ ] **Step 12.2: Run tests**

```bash
cd packages/sdk-swift && swift test 2>&1 | tail -10
```
Expected: 30 tests pass (3 M0 generated + 14 error + 4 observer + 4 config + 5 façade smoke).

NOTE: each smoke test calls `Rovenue.resetForTesting()` in setUp. This destroys the prior shared instance (calling shutdown + finishAll) but the SQLite cache file at `~/Library/Application Support/Rovenue/rovenue.db` persists across tests. The smoke tests rely on the initial state for a fresh identity — if a prior test wrote `user_42` to the cache, the `currentUserHasAnonId` test might fail because the cache holds the known id from a previous run.

To make tests independent of any shared cache state, the `test_facade_identifyEmitsChange` test calls `Rovenue.resetForTesting()` itself (via `setUp`) — but the underlying SQLite file isn't reset. If you find tests fail due to leftover state from prior runs, delete `~/Library/Application Support/Rovenue/rovenue.db` between runs.

Future work (separate plan): expose `RovenueCore.newWithDbPath(config:dbPath:)` in the UDL so Swift tests can use a tempdir.

- [ ] **Step 12.3: Commit**

```bash
git add packages/sdk-swift/Tests/RovenueTests/RovenueTests.swift
git commit -m "test(sdk-swift): façade smoke tests for currentUser/entitlements/credits/identify"
```

---

## Task 13: Parity smoke script — add Swift façade test count check

**Files:**
- Modify: `scripts/sdk-parity.sh`

The parity script already runs `swift test`. We update its assertion to allow the new test count (30 instead of 3).

- [ ] **Step 13.1: Inspect existing script**

```bash
grep -n -E 'swift test|Swift façade|swift -' scripts/sdk-parity.sh | head -10
```

Identify the line that runs `swift test` and any pattern-matching that asserts a specific test count.

- [ ] **Step 13.2: Update the script if it asserts test counts**

If the script uses `grep "3 tests, 0 failures"` or similar, change to:

```bash
# Swift façade — 30 tests (3 M0 + 14 error mapping + 4 observer + 4 config + 5 smoke)
( cd packages/sdk-swift && swift test 2>&1 | tail -3 ) | tee /tmp/rovenue-swift-parity.log
```

If the script simply checks `swift test` exit code (no count assertion), no change is needed.

The exact diff depends on the script's existing structure — read it first.

- [ ] **Step 13.3: Run parity**

```bash
./scripts/sdk-parity.sh 2>&1 | tail -15
```
Expected: exits 0. The Swift section reports the new test count.

If Swift isn't installed locally, the script's existing skip/warn path handles it.

- [ ] **Step 13.4: Commit**

```bash
git add scripts/sdk-parity.sh
git status --short
```

If no edits were needed (the script doesn't assert a specific count), `git status` is clean — skip the commit. Otherwise:

```bash
git commit -m "test(sdk): parity script accounts for M3 swift façade test count"
```

---

## Task 14: Final sweep — build/test/parity/commit count

- [ ] **Step 14.1: Full Swift build + test**

```bash
cd packages/sdk-swift && swift build 2>&1 | tail -3
cd packages/sdk-swift && swift test 2>&1 | tail -5
```
Expected: clean build, 30 tests pass.

- [ ] **Step 14.2: Rust core suite is unchanged**

```bash
source $HOME/.cargo/env && cargo test -p librovenue 2>&1 | grep -E 'test result' | awk '{sum+=$4} END {print "Rust total:", sum}'
```
Expected: 88 (M1 + M2 baseline, unchanged — we touched no Rust code).

- [ ] **Step 14.3: Parity script**

```bash
./scripts/sdk-parity.sh 2>&1 | tail -10
```
Expected: exits 0.

- [ ] **Step 14.4: Summarise commits since main**

```bash
git log --oneline main..HEAD
```
Expected: 11–13 commits with `feat(sdk-swift):` / `test(sdk-swift):` / `test(sdk):` prefixes.

- [ ] **Step 14.5: Hand-off**

After verification, ask the controller whether to:
1. Merge to main locally (no push)
2. Push + open PR
3. Leave the branch in the worktree for further iteration

---

## Self-Review Notes

**Spec coverage:**
- §"Public API Surface" — Tasks 6 (configure/shared/version), 7 (identity), 8 (entitlements), 9 (credits), 10 (receipts), 11 (lifecycle/observer)
- §"Public types" — Task 2 (Sendable+Equatable extensions on generated types)
- §"Errors" — Task 3 (`Rovenue.Error` + mapError exhaustive switch)
- §"Configuration lifecycle" — Task 6 (`configure` validates, replaces; `shared` fatalErrors if not configured)
- §"Architecture / Package layout" — Task 1 verifies; Tasks 4–11 populate
- §"Threading model" — Task 4 (Dispatcher)
- §"Observer bridge" — Task 5 (ObserverBridge with UUID-keyed multiplex)
- §"Type mapping" — Task 2 (extensions instead of wrappers, per deviation note)
- §"Error mapping" — Task 3 (exhaustive switch)
- §"Testing" — Tasks 3 (ErrorMappingTests), 5 (ObserverBridgeTests), 6 (ConfigurationTests), 12 (façade smoke in RovenueTests)
- §"Distribution" — Task 1 confirms SPM stays buildable

**Deviation from spec (documented above):**
- Public value types stay as the generated `User` / `Entitlement` / `ReceiptResult` / `ChangeEvent` (extended via `extension` for `Sendable + Equatable`). The spec's parallel-wrapper approach had a name-collision in the `Rovenue` module. The extension approach is more idiomatic Swift and serves the "thin wrapper" intent better.
- Public error type is `Rovenue.Error` (nested), not the top-level `RovenueError` the spec proposed — also a name-collision fix.

**Placeholder scan:** No TBDs; every code block is complete.

**Type consistency:**
- `Rovenue.Error` cases (Task 3) reused identically in Tasks 6, 7, 8, 9, 10, 12.
- `Dispatcher.run` / `runNonThrowing` (Task 4) consumed verbatim in Tasks 7, 8, 9, 10.
- `ObserverBridge` (Task 5) registered exactly once in `Rovenue.configure` (Task 6); subscribers obtain streams via `bridge.subscribe()` in Task 11's `changes` property.
- `Rovenue.shared`, `Rovenue.configure`, `Rovenue.version` (Task 6) used identically in Tasks 12 (smoke tests).
- `core.currentUser()`, `core.identify(knownUserId:)`, `core.entitlement(id:)`, `core.entitlementsAll()`, `core.refreshEntitlements()`, `core.creditBalance()`, `core.refreshCredits()`, `core.consumeCredits(amount:description:)`, `core.postAppleReceipt(receipt:productId:)`, `core.postGoogleReceipt(receipt:productId:)`, `core.setForeground(foreground:)`, `core.shutdown()`, `core.registerObserver(obs:)` — every call matches the generated `RovenueCore` signature verified in the pre-plan exploration.

**Cross-task dependencies:**
- Task 3 depends on Task 1 (bindings exist). The Errors.swift file references `RovenueError` cases from the generated binding.
- Task 5 depends on Tasks 1, 2 (`Observer` protocol, `ChangeEvent` enum). ObserverBridge implements the generated `Observer`.
- Task 6 depends on Tasks 3, 4, 5 (`Rovenue.Error`, `Dispatcher`, `ObserverBridge`).
- Tasks 7–11 depend on Task 6 (the `Rovenue` class skeleton with `core` + `bridge` + `dispatcher` properties).
- Task 12 depends on Tasks 6–11 (full public API).
- Task 13 depends on Task 12 (tests committed so the parity script can count them).

**Known risks:**
- SQLite cache file persistence across tests (noted in Task 12) — best-effort for M3; later test-infra plan should add db-path injection.
- `Rovenue.resetForTesting()` calls `core.shutdown()` which stops the polling thread. A subsequent `configure()` creates a NEW core with a NEW polling thread. Verify the polling thread doesn't leak — the M1 polling tests already prove drop-cleanup.
- `@unchecked Sendable` on the generated types is pragmatic. If a future Rust-side type adds a non-Sendable field (e.g., a callback closure), the extension will silently allow unsafe cross-actor passes. Mitigation: keep value types simple in the UDL.

---

*End of plan.*
