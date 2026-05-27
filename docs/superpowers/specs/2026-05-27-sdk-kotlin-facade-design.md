# SDK M4 — Kotlin Façade Design

## Overview

Idiomatic Kotlin wrapper around the Rovenue Rust core (librovenue). The façade is a **thin wrapper**: it converts the blocking, UniFFI-generated Rust API into modern Kotlin (`suspend fun` + `SharedFlow<ChangeEvent>`) without taking on Play Billing integration. The consuming Android app continues to own its `BillingClient.launchBillingFlow` flow and hands the resulting purchase token to `Rovenue.shared.postGoogleReceipt(receipt, productId)`.

This spec covers the Kotlin façade only. It is the direct counterpart of the [Swift M3 façade](./2026-05-26-sdk-swift-facade-design.md). React Native façade follows in a separate plan.

## Goals

- Public API that feels native to Kotlin developers (`suspend fun`, `SharedFlow`, sealed-class exceptions).
- Singleton lifecycle matching the M3 Swift pattern (`Rovenue.configure(...)` + `Rovenue.shared`).
- Single multicast `SharedFlow<ChangeEvent>` for cache-change notifications.
- **No error mapping layer.** Use the UniFFI-generated `RovenueException` directly — it's already a `sealed class` with PascalCase subclasses, which is idiomatic Kotlin. This is the key design simplification over Swift M3, which had to add a `Rovenue.Error` enum to escape Swift's name-collision rules.
- Gradle + Maven Central distribution. JVM target only for M4.
- Kotlin 1.9 / JVM 17 baseline (matches existing M0 build.gradle.kts).

## Non-Goals

- **Play Billing integration.** No `Rovenue.shared.purchase(productId)`, no `BillingClient` wiring, no `PurchasesUpdatedListener`. Consumer-app code drives Play Billing; the façade only accepts the resulting purchase token via `postGoogleReceipt`.
- **Restore purchases.** Would need to call `BillingClient.queryPurchasesAsync` and post each — defer to a later "Kotlin Play Billing integration" plan.
- **Android-specific dependencies.** No `androidx.lifecycle`, no `ProcessLifecycleOwner` auto-wiring for `setForeground`. The JVM module is pure Kotlin so it works in unit tests, server-side, and Android. Android lifecycle helpers land in a future `:sdk-android` artifact.
- **`RxJava` or `Reactive Streams` interop.** `Flow` only. Consumers wanting Rx can call `.asObservable()` themselves.
- **End-to-end HTTP tests at the Kotlin layer.** Rust core has 89 mockito-driven tests covering the wire contract; the Kotlin layer's tests focus on wrapping logic (configuration lifecycle, observer multiplex, façade smoke). E2E coverage is deferred.
- **Multi-tenant `Rovenue` instances.** Singleton-only for M4. Same rationale as Swift M3.

## Architectural decisions vs Swift M3

| Concern | Swift M3 | Kotlin M4 | Reason |
|---|---|---|---|
| Singleton class | `final class Rovenue` + static `shared` | `class Rovenue` + `companion object { shared }` | Direct mirror. Kotlin `object Rovenue` (true singleton) would forbid configure-twice re-initialization. |
| Blocking-bridge | Internal `Dispatcher` (serial `DispatchQueue`, `withCheckedThrowingContinuation`) | Internal `Dispatcher` (`withContext(Dispatchers.IO)`) | `Dispatchers.IO` is the canonical Kotlin pattern for blocking off-loaded work. No serial queue needed — Rust core's `Arc<Mutex<…>>` already serializes per-instance. |
| Observer multicast | `AsyncStream` + UUID-keyed continuation table | `MutableSharedFlow<ChangeEvent>` exposed as `SharedFlow` | `SharedFlow` has multicast + bounded buffer + drop-oldest backpressure built in — no manual table needed. This is strictly simpler than the Swift bridge. |
| Error surface | Nested `Rovenue.Error` enum + exhaustive `mapError()` | **Generated `RovenueException` direct** | Kotlin's sealed-class exception model is already idiomatic; the generated names (`RovenueException.InvalidApiKey`, etc.) need no renaming. Saves an entire file + 14 mapping tests vs M3. |
| Value types | `Sendable + Equatable` extensions on generated types | Generated `data class` (free `equals`/`hashCode`/`copy`) | Kotlin data classes synthesize what we needed in Swift. No work. |
| Coroutine scope | N/A (no scope needed; AsyncStream owns its continuation) | Internal `CoroutineScope(SupervisorJob() + Dispatchers.Default)` | Needed to drive `MutableSharedFlow.emit` from the synchronous Observer callback. Scope cancels on `shutdown()` / `resetForTesting()`. |

## Public API Surface

### `Rovenue` class

```kotlin
package dev.rovenue.sdk

import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.Entitlement
import dev.rovenue.sdk.generated.ReceiptResult
import dev.rovenue.sdk.generated.RovenueException
import dev.rovenue.sdk.generated.User
import kotlinx.coroutines.flow.SharedFlow

class Rovenue private constructor(
    internal val core: RovenueCore,
    internal val bridge: ObserverBridge,
    internal val dispatcher: Dispatcher,
    internal val scope: CoroutineScope,
) {
    companion object {
        /** Configure the SDK. Must be called before any other API.
         *  Throws RovenueException.InvalidApiKey if apiKey is blank.
         *  Calling twice replaces the shared instance. */
        @Throws(RovenueException::class)
        fun configure(apiKey: String, baseUrl: String, debug: Boolean = false)

        /** Returns the configured singleton. Throws IllegalStateException
         *  (NOT a RovenueException — pre-configuration is a programmer error,
         *  not a runtime SDK failure) if configure() has not been called. */
        val shared: Rovenue

        /** Test-only. Tears down the prior instance (scope cancel + core
         *  shutdown + flow finish) and clears the singleton slot. */
        @VisibleForTesting
        internal fun resetForTesting()
    }

    // -------------------------------------------------------------------
    // Sync accessors
    // -------------------------------------------------------------------
    val version: String                                  // sdkVersion()
    val changes: SharedFlow<ChangeEvent>                 // multicast event stream

    // -------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------
    suspend fun currentUser(): User
    @Throws(RovenueException::class)
    suspend fun identify(knownUserId: String)

    // -------------------------------------------------------------------
    // Entitlements (cache-first reads; refresh hits HTTP)
    // -------------------------------------------------------------------
    suspend fun entitlement(id: String): Entitlement?
    suspend fun entitlementsAll(): List<Entitlement>
    @Throws(RovenueException::class)
    suspend fun refreshEntitlements()

    // -------------------------------------------------------------------
    // Credits
    // -------------------------------------------------------------------
    suspend fun creditBalance(): Long
    @Throws(RovenueException::class)
    suspend fun refreshCredits()
    @Throws(RovenueException::class)
    suspend fun consumeCredits(amount: Long, description: String? = null): Long

    // -------------------------------------------------------------------
    // Receipts
    // -------------------------------------------------------------------
    @Throws(RovenueException::class)
    suspend fun postAppleReceipt(jws: String, productId: String): ReceiptResult
    @Throws(RovenueException::class)
    suspend fun postGoogleReceipt(receipt: String, productId: String): ReceiptResult

    // -------------------------------------------------------------------
    // Lifecycle (sync forwards to Rust core)
    // -------------------------------------------------------------------
    fun setForeground(foreground: Boolean)
    fun shutdown()
}
```

### Generated types reused directly

`User`, `Entitlement`, `ReceiptResult`, `ChangeEvent` — all UniFFI-generated `data class` / `sealed class` from `librovenue.kt`. No wrapping, no extensions. Kotlin's auto-generated `equals/hashCode/copy/toString` plus sealed-class exhaustive `when` give us what Swift needed extension code to achieve.

### Error type — `RovenueException`

Used directly from the generated binding:

```kotlin
sealed class RovenueException(message: String) : Exception(message) {
    class NotConfigured(message: String) : RovenueException(message)
    class InvalidApiKey(message: String) : RovenueException(message)
    class ServerError(message: String) : RovenueException(message)
    class NetworkUnavailable(message: String) : RovenueException(message)
    class Timeout(message: String) : RovenueException(message)
    class RateLimited(message: String) : RovenueException(message)
    class Storage(message: String) : RovenueException(message)
    class UserNotFound(message: String) : RovenueException(message)
    class InsufficientCredits(message: String) : RovenueException(message)
    class EntitlementInactive(message: String) : RovenueException(message)
    class DuplicatePurchase(message: String) : RovenueException(message)
    class ReceiptInvalid(message: String) : RovenueException(message)
    class Internal(message: String) : RovenueException(message)
}
```

`when (e)` over an instance is exhaustive. No mapping layer.

## Internal architecture

### `Dispatcher`

```kotlin
internal class Dispatcher {
    suspend fun <T> run(block: () -> T): T = withContext(Dispatchers.IO) {
        // Cooperative cancellation: if the calling coroutine cancels,
        // the IO thread completes its current block then returns; the
        // suspending point above re-raises CancellationException.
        block()
    }
}
```

No serial queue. The Rust core's `Arc<Mutex<…>>` already serializes concurrent calls per-instance. `Dispatchers.IO` provides a bounded thread pool (64 threads by default) optimal for blocking work.

### `ObserverBridge`

```kotlin
internal class ObserverBridge(private val scope: CoroutineScope) : Observer {
    private val _flow = MutableSharedFlow<ChangeEvent>(
        replay = 0,
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** Called by UniFFI on the Rust observer thread.
     *  tryEmit is non-suspending and returns false only when the buffer is
     *  full and DROP_OLDEST drops one — we accept the drop silently here
     *  (an observer that's 64 events behind will resync on next refresh). */
    override fun onChange(event: ChangeEvent) {
        _flow.tryEmit(event)
    }

    val flow: SharedFlow<ChangeEvent> = _flow.asSharedFlow()
}
```

Notes:
- **No UUID-keyed table.** `SharedFlow` natively multicasts to every `collect{}` caller. This is the single biggest simplification over Swift M3's bridge.
- **`tryEmit` over `emit`** because the Rust observer callback is synchronous. `emit` would suspend, which we can't do from a non-coroutine context.
- **DROP_OLDEST policy** matches the spec's "events are advisory cache hints; reading current state is always the source of truth." A consumer that pauses for 65 events loses the oldest one but the cache reads are unaffected.
- The `scope` parameter is held for parity with future enhancements (e.g., async filtering) — unused in M4 but cheap to wire.

### Singleton lifecycle

```kotlin
companion object {
    private val lock = Any()
    @Volatile private var _shared: Rovenue? = null

    @Throws(RovenueException::class)
    fun configure(apiKey: String, baseUrl: String, debug: Boolean = false) {
        if (apiKey.isBlank()) throw RovenueException.InvalidApiKey("apiKey is blank")
        val config = Config(apiKey = apiKey, baseUrl = baseUrl, debug = debug)
        val core = RovenueCore(config)                   // may throw RovenueException
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val bridge = ObserverBridge(scope)
        core.registerObserver(bridge)
        synchronized(lock) {
            _shared?.shutdownInternal()
            _shared = Rovenue(core, bridge, Dispatcher(), scope)
        }
    }

    val shared: Rovenue
        get() = _shared ?: error("Rovenue: must call Rovenue.configure() before accessing shared")

    @VisibleForTesting
    internal fun resetForTesting() {
        synchronized(lock) {
            _shared?.shutdownInternal()
            _shared = null
        }
    }
}

private fun shutdownInternal() {
    scope.cancel()
    core.shutdown()
}
```

## File layout

**New:**
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/Dispatcher.kt`
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ObserverBridge.kt`
- `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ConfigurationTest.kt`
- `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ObserverBridgeTest.kt`

**Modified:**
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` — replaces M0 `object Rovenue { val version }` stub with the full façade class.
- `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/RovenueTest.kt` — keeps 3 M0 smoke tests, adds 5 façade smoke tests (matching Swift M3 Step 12.1).
- `packages/sdk-kotlin/build.gradle.kts` — adds `kotlinx-coroutines-core` (main) + `kotlinx-coroutines-test` (test).

**Untouched:** `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt` (regenerated by `./packages/core-rs/scripts/build-bindings.sh` — gitignored).

## Dependencies

```kotlin
// build.gradle.kts additions
dependencies {
    implementation("net.java.dev.jna:jna:5.14.0")            // existing
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")   // NEW
    testImplementation(kotlin("test"))                       // existing
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")  // existing
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.0")  // NEW
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")  // existing
}
```

No JDK bump (existing `jvmToolchain(17)` is fine). No Kotlin version bump (1.9.23 supports coroutines 1.8.0).

## Testing

| File | Count | Mirrors Swift M3 |
|---|---|---|
| `RovenueTest.kt` | 3 M0 + 5 façade smoke = 8 | `RovenueTests.swift` (3+5) |
| `ConfigurationTest.kt` | 4 | `ConfigurationTests.swift` |
| `ObserverBridgeTest.kt` | 4 | `ObserverBridgeTests.swift` |
| **Total** | **16** | (Swift had 30 because of 14 ErrorMappingTests — eliminated here, no mapping) |

Tests use `runTest { }` from `kotlinx-coroutines-test` for `suspend fun` testing. `MutableSharedFlow` testing uses `flow.take(N).toList()` with `launch` + `delay`-free patterns from `coroutines-test`.

### Test isolation caveat

Same caveat as Swift M3: each test calls `Rovenue.resetForTesting()` in `@BeforeEach`, which destroys the prior instance and cancels its scope. The underlying SQLite cache file (resolved via the Rust core's data-dir logic — on Linux `~/.local/share/Rovenue/rovenue.db`, on macOS `~/Library/Application Support/Rovenue/rovenue.db`) persists across tests. The `test_facade_identifyEmitsChange`-equivalent test must run with a clean cache, or run after `resetForTesting()` and accept a stale anon_id from a prior run. Same deferred fix as Swift M3: expose a `dbPath` overload in a future plan.

## Distribution

JVM `.jar` via `./gradlew :sdk-kotlin:build`. Maven Central publish (`dev.rovenue:sdk:0.1.0`) wired in a later release plan — not part of M4. Local consumers can `mavenLocal()` from `./gradlew :sdk-kotlin:publishToMavenLocal`.

`librovenue.so` / `librovenue.dylib` packaging into the jar's resources is **out of scope** for M4 — tests use `jna.library.path` system-property pointing at `target/release/` (existing setup in `build.gradle.kts:25-28`). The Maven Central publication plan handles bundling.

## CI

The existing `.github/workflows/sdk.yml` (`5f0874d ci(sdk): rust + swift + kotlin + rn jobs`) already runs `./gradlew :sdk-kotlin:test`. No CI changes needed for M4 beyond verifying the new test count passes.

## Risks / Open issues

- **DROP_OLDEST silent drops.** A consumer that doesn't collect fast enough loses events. Acceptable per the "events are advisory" stance — but document it loudly in the public KDoc on `changes`.
- **`CoroutineScope` leak on configure-twice.** `shutdownInternal()` cancels the prior scope, but in-flight `tryEmit` callbacks from the Rust observer thread that occur between `core.shutdown()` and `_shared = …` reassignment could `tryEmit` into a finished flow. Mitigation: `tryEmit` on a closed `MutableSharedFlow` returns `false` without throwing — the events are silently dropped, matching the DROP_OLDEST stance.
- **JNA on Apple Silicon.** Existing M0 tests pass on `arm64` via JNA 5.14. No M4-specific risk; flagged for awareness if the test job runs on a runner without native arm64.
- **No structured concurrency around `shutdown()`.** Calling `shutdown()` from inside a coroutine that was launched on the SDK's internal scope will cancel itself mid-flight. Document this as "call `shutdown()` from outside any Rovenue-launched coroutine" — same warning consumers of OkHttp's `dispatcher.executorService().shutdown()` get.

## Spec self-review notes

- **Placeholder scan:** No TBD / TODO. Every section is concrete.
- **Internal consistency:** The "no error mapping" decision propagates to: missing `Errors.kt` file, missing `mapException()` function, test-count of 16 (not 30), and the API signatures all `@Throws(RovenueException::class)` directly. Internally consistent.
- **Scope check:** This is a single implementation plan. 10–11 tasks of mirror-from-Swift-M3 work. Comfortably one milestone.
- **Ambiguity check:** "Configure-twice" semantics explicitly described (prior shutdown + new instance). "DROP_OLDEST" buffer policy explicitly named. `shared` accessor's failure mode (IllegalStateException, NOT RovenueException) explicitly justified.

---

*End of design.*
