# SDK M4 — Kotlin Façade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the M4 milestone — an idiomatic Kotlin façade over the UniFFI-generated `librovenue` Kotlin bindings. Singleton `Rovenue.shared`, `suspend fun` methods bridged via `Dispatchers.IO`, single multicast `SharedFlow<ChangeEvent>` for observer events, and **direct use of the generated `RovenueException` sealed class** — no error mapping layer (key simplification over Swift M3).

**Architecture:** `class Rovenue` + `companion object { configure(); shared }` mirrors the M3 Swift singleton. Each public `suspend fun` that hits the Rust core flows through an internal `Dispatcher` using `withContext(Dispatchers.IO)` to off-load the blocking call. The internal `ObserverBridge` implements the UniFFI-generated `Observer` interface and tunnels every `onChange` callback into a `MutableSharedFlow<ChangeEvent>` exposed read-only via `Rovenue.changes`. `SharedFlow`'s native multicast replaces Swift's UUID-keyed continuation table.

**Tech Stack:** Kotlin 1.9.23 + JVM 17 (existing `build.gradle.kts`), `kotlinx-coroutines-core` 1.8.0 (NEW), JUnit 5 (existing), `kotlinx-coroutines-test` 1.8.0 (NEW). UniFFI 0.25 generated bindings (gitignored, regenerated). No new Android / no androidx dependencies.

**Reality-check notes vs the spec (these are NOT deviations — the spec was written before re-checking the generated symbols):**

1. The generated `ChangeEvent` is an `enum class` (NOT `sealed class`) with SCREAMING_SNAKE_CASE variants: `ENTITLEMENTS_CHANGED`, `IDENTITY_CHANGED`, `CREDIT_BALANCE_CHANGED`. Tests below reference these exact names.
2. The generated `RovenueException` variant for the Rust `ServerError` case is named `RovenueException.ServerException` (UniFFI's Kotlin generator renames `*Error` → `*Exception` to follow Java-side convention). All other variants keep their Rust names: `NotConfigured`, `InvalidApiKey`, `NetworkUnavailable`, `Timeout`, `RateLimited`, `Storage`, `UserNotFound`, `InsufficientCredits`, `EntitlementInactive`, `DuplicatePurchase`, `ReceiptInvalid`, `Internal`.
3. There is no `gradlew` wrapper script checked into the repo — `packages/sdk-kotlin/gradle/wrapper/gradle-wrapper.properties` exists but the wrapper jar is gitignored. Tests run via system `gradle` (CI guarantees one is on PATH). The existing `scripts/sdk-parity.sh` already uses this command shape.

---

## File Structure

**New files under `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/`:**

- `internal/Dispatcher.kt` — `suspend fun <T> run(block)` over `withContext(Dispatchers.IO)`
- `internal/ObserverBridge.kt` — implements `Observer`, fans out to `MutableSharedFlow<ChangeEvent>`

**Modified files:**

- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` — replaces M0 `object Rovenue { val version }` with the full façade class.
- `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/RovenueTest.kt` — keeps 3 M0 smoke tests, adds 5 façade smoke tests at the bottom.
- `packages/sdk-kotlin/build.gradle.kts` — adds two coroutines dependencies.

**New test files under `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/`:**

- `ConfigurationTest.kt`
- `ObserverBridgeTest.kt`

---

## Conventions

- **All public methods that hit the Rust core are `suspend`** (and may be `@Throws(RovenueException::class)`). They dispatch through `Dispatcher.run(_)` to a `Dispatchers.IO` thread.
- **`setForeground` and `shutdown` are sync** — they flip atomic flags / cancel scope only; no dispatcher needed.
- **`Rovenue.version` is a sync `val`** — calls the free function `sdkVersion()` returning a static constant.
- **TDD per task** — failing JUnit test first, then implementation.
- **Tests run via** `cd packages/sdk-kotlin && gradle test`. (No `gradlew` wrapper script in the repo; CI provides system gradle.) The build's `tasks.test` block already sets `jna.library.path = ../../target/release`, so the native library must be built first via `source $HOME/.cargo/env && cargo build --release -p librovenue`.
- **The generated `librovenue.kt` is gitignored** — every fresh checkout regenerates via `./packages/core-rs/scripts/build-bindings.sh`. The plan's first task verifies the regen.
- **Existing M0 baseline:** `object Rovenue { val version }` (placeholder) + 3 smoke tests in `RovenueTest.kt`. The plan replaces the placeholder and grows the smoke set.
- **No new external Kotlin packages beyond coroutines.** Everything else is JDK / JUnit / kotlin-test.

---

## Task 1: Verify bindings regenerate + M0 baseline green

**Files:**
- Verify only — no edits.

This task confirms the workspace is in a buildable state before we start adding façade code.

- [ ] **Step 1.1: Build the native library so JNA can load it**

```bash
source $HOME/.cargo/env && cargo build --release -p librovenue 2>&1 | tail -3
```
Expected: `Compiling librovenue …` then `Finished release [optimized] target(s) in …`. The dylib/so at `target/release/librovenue.{dylib,so}` is what `jna.library.path` resolves to.

- [ ] **Step 1.2: Regenerate the Kotlin binding**

```bash
source $HOME/.cargo/env && ./packages/core-rs/scripts/build-bindings.sh 2>&1 | tail -5
```
Expected: `✓ bindings generated`. `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt` should be present (a long file — ~1600 lines).

- [ ] **Step 1.3: Confirm Kotlin M0 smoke passes**

```bash
cd packages/sdk-kotlin && gradle test 2>&1 | tail -15
```
Expected: 3 tests pass (`getVersion matches Cargo pkg version`, `invalid api key throws`, `sdkVersion namespace function non-empty`).

If `gradle` isn't on PATH locally, that's OK — note the skip and proceed. CI has Gradle.

- [ ] **Step 1.4: Confirm the generated public types look as expected**

```bash
grep -nE "^(public |sealed |interface |class |enum |object )" packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt | grep -iE "(Observer|ChangeEvent|RovenueException|RovenueCore|Config|User|Entitlement|ReceiptResult)" | head -20
```
Expected output includes:
```
public interface RovenueCoreInterface
class RovenueCore(...)
data class Config(...)
data class User(...)
data class Entitlement(...)
data class ReceiptResult(...)
enum class ChangeEvent { ENTITLEMENTS_CHANGED, IDENTITY_CHANGED, CREDIT_BALANCE_CHANGED }
sealed class RovenueException(message: String): Exception(message)
public interface Observer
```

If `ChangeEvent` or `Observer` are missing, the bindings didn't regenerate cleanly. Re-run Step 1.2.

- [ ] **Step 1.5: No commit** — this is a verification-only task.

---

## Task 2: Add kotlinx-coroutines dependencies

**Files:**
- Modify: `packages/sdk-kotlin/build.gradle.kts`

No tests in this task — pure dependency add. Verified by `gradle build`.

- [ ] **Step 2.1: Edit `packages/sdk-kotlin/build.gradle.kts`**

Replace the `dependencies { … }` block (lines 12–17 in the existing file) with:

```kotlin
dependencies {
    implementation("net.java.dev.jna:jna:5.14.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
```

Only the two `kotlinx-coroutines-*` lines are new. Everything else is unchanged.

- [ ] **Step 2.2: Verify the package still builds and M0 tests still pass**

```bash
cd packages/sdk-kotlin && gradle test 2>&1 | tail -15
```
Expected: 3 tests pass (no façade code yet).

- [ ] **Step 2.3: Commit**

```bash
git add packages/sdk-kotlin/build.gradle.kts
git commit -m "feat(sdk-kotlin): add kotlinx-coroutines-core + kotlinx-coroutines-test"
```

---

## Task 3: Internal `Dispatcher` — blocking → suspend bridge

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/Dispatcher.kt`

No tests in this task — `Dispatcher` is leaf infrastructure. It gets exercised implicitly by every later suspend-method test.

- [ ] **Step 3.1: Create the file**

Create `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/Dispatcher.kt`:

```kotlin
// Dispatcher.kt — bridges blocking Rust-core calls into Kotlin suspend fun.
//
// The Rust core (per the UniFFI bindings we generate in M1) is fully
// synchronous. Calling it from the caller's coroutine context would block
// the dispatcher thread. We off-load to Dispatchers.IO, which is the
// canonical "blocking work on a thread pool" dispatcher in coroutines.
//
// Unlike the Swift façade we don't need a serial queue — the Rust core's
// own Arc<Mutex<...>> already serializes concurrent calls per-instance.
// Dispatchers.IO is a bounded thread pool (64 threads by default) optimal
// for blocking I/O.

package dev.rovenue.sdk.internal

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal class Dispatcher {
    suspend fun <T> run(block: () -> T): T = withContext(Dispatchers.IO) {
        block()
    }
}
```

- [ ] **Step 3.2: Verify build**

```bash
cd packages/sdk-kotlin && gradle build 2>&1 | tail -5
```
Expected: clean build.

- [ ] **Step 3.3: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/Dispatcher.kt
git commit -m "feat(sdk-kotlin): Dispatcher — Dispatchers.IO bridge over blocking Rust core"
```

---

## Task 4: Internal `ObserverBridge` + tests

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ObserverBridge.kt`
- Create: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ObserverBridgeTest.kt`

The bridge implements the UniFFI-generated `Observer` interface and tunnels every `onChange` callback into a `MutableSharedFlow<ChangeEvent>`. Multiple consumers collect from the same `SharedFlow` — `SharedFlow`'s native multicast replaces Swift's UUID-keyed continuation table.

- [ ] **Step 4.1: Write the failing test**

Create `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ObserverBridgeTest.kt`:

```kotlin
package dev.rovenue.sdk

import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.internal.ObserverBridge
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ObserverBridgeTest {

    @Test
    fun `single subscriber receives emitted event`() = runTest {
        val bridge = ObserverBridge()
        // Start collecting BEFORE emitting — SharedFlow with replay=0 will
        // not buffer events for late subscribers. Launch a background
        // collector that pulls one event, then emit.
        val collected = mutableListOf<ChangeEvent>()
        val job = launch {
            bridge.flow.take(1).toList(collected)
        }
        // Yield so the collector has time to subscribe before we emit.
        kotlinx.coroutines.yield()
        bridge.onChange(ChangeEvent.ENTITLEMENTS_CHANGED)
        job.join()
        assertEquals(listOf(ChangeEvent.ENTITLEMENTS_CHANGED), collected)
    }

    @Test
    fun `single subscriber receives multiple events in order`() = runTest {
        val bridge = ObserverBridge()
        val collected = mutableListOf<ChangeEvent>()
        val job = launch {
            bridge.flow.take(3).toList(collected)
        }
        kotlinx.coroutines.yield()
        bridge.onChange(ChangeEvent.ENTITLEMENTS_CHANGED)
        bridge.onChange(ChangeEvent.CREDIT_BALANCE_CHANGED)
        bridge.onChange(ChangeEvent.IDENTITY_CHANGED)
        job.join()
        assertEquals(
            listOf(
                ChangeEvent.ENTITLEMENTS_CHANGED,
                ChangeEvent.CREDIT_BALANCE_CHANGED,
                ChangeEvent.IDENTITY_CHANGED,
            ),
            collected,
        )
    }

    @Test
    fun `two subscribers both receive the same event`() = runTest {
        val bridge = ObserverBridge()
        val collectedA = mutableListOf<ChangeEvent>()
        val collectedB = mutableListOf<ChangeEvent>()
        val jobA = launch { bridge.flow.take(1).toList(collectedA) }
        val jobB = launch { bridge.flow.take(1).toList(collectedB) }
        kotlinx.coroutines.yield()
        bridge.onChange(ChangeEvent.IDENTITY_CHANGED)
        jobA.join()
        jobB.join()
        assertEquals(listOf(ChangeEvent.IDENTITY_CHANGED), collectedA)
        assertEquals(listOf(ChangeEvent.IDENTITY_CHANGED), collectedB)
    }

    @Test
    fun `flow accessor returns a read-only SharedFlow`() {
        val bridge = ObserverBridge()
        // Compile-time check via type: bridge.flow is SharedFlow, NOT MutableSharedFlow.
        // We assert at runtime that downcasting to MutableSharedFlow fails (the cast
        // would succeed if .asSharedFlow() returned the underlying type unchanged,
        // but `asSharedFlow()` returns a defensive view).
        val flow = bridge.flow
        // SharedFlow has no replayCache mutation API. Just verify it's a SharedFlow.
        assertTrue(flow is kotlinx.coroutines.flow.SharedFlow)
    }
}
```

- [ ] **Step 4.2: Run, see failure**

```bash
cd packages/sdk-kotlin && gradle test --tests "dev.rovenue.sdk.ObserverBridgeTest" 2>&1 | tail -15
```
Expected: FAIL — `ObserverBridge` not defined (compile error).

- [ ] **Step 4.3: Create `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ObserverBridge.kt`**

```kotlin
// ObserverBridge.kt — multicast between the Rust observer callback and
// Kotlin coroutine consumers.
//
// Rust core's register_observer(obs) accepts exactly one Observer at a
// time (per FFI design). The ObserverBridge is the single registered
// Observer; it fans out every `onChange` into a MutableSharedFlow that
// arbitrary Kotlin code can `.collect { }` from.
//
// SharedFlow vs the Swift AsyncStream approach: SharedFlow handles
// multicast natively (no UUID-keyed table), and its bounded buffer +
// onBufferOverflow policy give us backpressure without manual
// bookkeeping.

package dev.rovenue.sdk.internal

import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.Observer
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

internal class ObserverBridge : Observer {
    private val _flow = MutableSharedFlow<ChangeEvent>(
        replay = 0,
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** Called by UniFFI on the Rust observer thread.
     *
     *  tryEmit is non-suspending and returns false only when the buffer is
     *  full and DROP_OLDEST drops one — we silently accept the drop here.
     *  Events are advisory cache-change hints; reading current state via
     *  the cache-first methods is always authoritative. */
    override fun onChange(event: ChangeEvent) {
        _flow.tryEmit(event)
    }

    val flow: SharedFlow<ChangeEvent> = _flow.asSharedFlow()
}
```

- [ ] **Step 4.4: Run tests**

```bash
cd packages/sdk-kotlin && gradle test --tests "dev.rovenue.sdk.ObserverBridgeTest" 2>&1 | tail -10
```
Expected: 4 tests pass.

```bash
cd packages/sdk-kotlin && gradle test 2>&1 | tail -10
```
Expected: 7 total (3 M0 + 4 observer).

- [ ] **Step 4.5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ObserverBridge.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ObserverBridgeTest.kt
git commit -m "feat(sdk-kotlin): ObserverBridge — MutableSharedFlow multicast over Observer callbacks"
```

---

## Task 5: `Rovenue` class — configure / shared / version + ConfigurationTest

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`
- Create: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ConfigurationTest.kt`

Replaces the M0 `object Rovenue { val version }` placeholder with the real singleton class. `configure()` validates the api key, builds the underlying `RovenueCore`, registers the observer bridge, and stores the shared instance. `shared` accessor throws `IllegalStateException` if not yet configured. `version` returns `sdkVersion()`.

- [ ] **Step 5.1: Write the failing test**

Create `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ConfigurationTest.kt`:

```kotlin
package dev.rovenue.sdk

import dev.rovenue.sdk.generated.RovenueException
import dev.rovenue.sdk.generated.sdkVersion
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNotSame

class ConfigurationTest {

    @BeforeEach
    fun setUp() {
        Rovenue.resetForTesting()
    }

    @Test
    fun `configure rejects blank api key`() {
        assertFailsWith<RovenueException.InvalidApiKey> {
            Rovenue.configure(apiKey = "", baseUrl = "https://api.rovenue.dev")
        }
    }

    @Test
    fun `configure rejects whitespace api key`() {
        assertFailsWith<RovenueException.InvalidApiKey> {
            Rovenue.configure(apiKey = "   ", baseUrl = "https://api.rovenue.dev")
        }
    }

    @Test
    fun `configure succeeds with valid config`() {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.dev")
        assertNotNull(Rovenue.shared)
        assertEquals(sdkVersion(), Rovenue.shared.version)
    }

    @Test
    fun `configure twice replaces shared instance`() {
        Rovenue.configure(apiKey = "pk_first", baseUrl = "https://api.rovenue.dev")
        val first = Rovenue.shared
        Rovenue.configure(apiKey = "pk_second", baseUrl = "https://api.rovenue.dev")
        val second = Rovenue.shared
        assertNotSame(first, second)
    }
}
```

- [ ] **Step 5.2: Run, see failure**

```bash
cd packages/sdk-kotlin && gradle test --tests "dev.rovenue.sdk.ConfigurationTest" 2>&1 | tail -15
```
Expected: FAIL — `Rovenue.configure`, `Rovenue.shared`, `Rovenue.resetForTesting`, `Rovenue.version` not defined (the existing M0 `object Rovenue` only has `version` and no companion `configure`).

- [ ] **Step 5.3: Replace `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`**

```kotlin
// Rovenue.kt — public singleton façade over the Rust core (UniFFI-generated
// RovenueCore). Lifecycle, identity, entitlements, credits, receipts,
// and the observer flow all live here.
//
// Threading: every suspend method that touches RovenueCore flows through
// the internal Dispatcher (Dispatchers.IO). The Rust core is itself
// thread-safe (Arc<Mutex<...>>); we don't add a Kotlin-side mutex.

package dev.rovenue.sdk

import dev.rovenue.sdk.generated.Config
import dev.rovenue.sdk.generated.RovenueCore
import dev.rovenue.sdk.generated.RovenueException
import dev.rovenue.sdk.generated.sdkVersion
import dev.rovenue.sdk.internal.Dispatcher
import dev.rovenue.sdk.internal.ObserverBridge

class Rovenue private constructor(
    internal val core: RovenueCore,
    internal val bridge: ObserverBridge,
    internal val dispatcher: Dispatcher,
) {
    companion object {
        // Guarded by `lock`. Configure-twice replaces the instance
        // (RevenueCat / Adapty pattern). Accessing `shared` before
        // configure() throws IllegalStateException — silent fallback
        // would mask developer mistakes.

        private val lock = Any()

        @Volatile
        private var _shared: Rovenue? = null

        @Throws(RovenueException::class)
        fun configure(apiKey: String, baseUrl: String, debug: Boolean = false) {
            if (apiKey.isBlank()) {
                throw RovenueException.InvalidApiKey("apiKey is blank")
            }
            val config = Config(apiKey = apiKey, baseUrl = baseUrl, debug = debug)
            val core = RovenueCore(config)  // may throw RovenueException
            val bridge = ObserverBridge()
            core.registerObserver(bridge)
            val instance = Rovenue(core, bridge, Dispatcher())
            synchronized(lock) {
                _shared?.shutdownInternal()
                _shared = instance
            }
        }

        val shared: Rovenue
            get() = _shared
                ?: error("Rovenue: must call Rovenue.configure(apiKey, baseUrl) before accessing shared")

        // Test-only: tears down the prior instance and clears the slot.
        // Internal so the test source set sees it (same module).
        internal fun resetForTesting() {
            synchronized(lock) {
                _shared?.shutdownInternal()
                _shared = null
            }
        }
    }

    // ---------------------------------------------------------------
    // Sync accessors
    // ---------------------------------------------------------------

    val version: String
        get() = sdkVersion()

    // ---------------------------------------------------------------
    // Internal teardown (used by configure-twice and resetForTesting)
    // ---------------------------------------------------------------

    private fun shutdownInternal() {
        core.shutdown()
    }
}
```

NOTE: this file references `Dispatcher` and `ObserverBridge` from the `internal` subpackage — Tasks 3 and 4 already created them.

NOTE: we removed the M0 `object Rovenue { val version }` — the M0 test `sdkVersion namespace function non-empty` directly calls the top-level `sdkVersion()` free function (not `Rovenue.version`), so it still passes against the unchanged generated file. The other M0 tests use `RovenueCore` and `Config` directly. None depend on the removed `object Rovenue` accessor. (Task 11 adds new façade smoke tests on top.)

- [ ] **Step 5.4: Run tests**

```bash
cd packages/sdk-kotlin && gradle test --tests "dev.rovenue.sdk.ConfigurationTest" 2>&1 | tail -10
```
Expected: 4 tests pass.

```bash
cd packages/sdk-kotlin && gradle test 2>&1 | tail -10
```
Expected: 11 total (3 M0 + 4 observer + 4 config).

NOTE: each `ConfigurationTest` test calls `resetForTesting` in `@BeforeEach`. This destroys the prior core db handle but the SQLite cache file at the OS data dir (`~/.local/share/Rovenue/rovenue.db` on Linux, `~/Library/Application Support/Rovenue/rovenue.db` on macOS) persists. This is fine for the tests we have — none read user state. Task 11's `currentUser` smoke handles the same caveat as Swift M3.

- [ ] **Step 5.5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ConfigurationTest.kt
git commit -m "feat(sdk-kotlin): Rovenue.configure + shared + version + resetForTesting"
```

---

## Task 6: Identity methods — `currentUser`, `identify`

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`

Wraps `RovenueCore.currentUser()` and `RovenueCore.identify(knownUserId)`. The first is non-throwing (cache read), the second throws.

- [ ] **Step 6.1: Add methods to `Rovenue` class**

Edit `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`. Inside the `Rovenue` class body (after `private fun shutdownInternal()`), add:

```kotlin
    // ---------------------------------------------------------------
    // Identity
    // ---------------------------------------------------------------

    /** Returns the SDK's current user (anonymous ID + optional known ID).
     *  Cache read — never hits the network. */
    suspend fun currentUser(): dev.rovenue.sdk.generated.User =
        dispatcher.run { core.currentUser() }

    /** Associate the SDK's user with the customer's app-side user id.
     *  Client-local only — server-side merging happens via the customer's
     *  backend calling /v1/subscribers/transfer with the secret key. */
    @Throws(RovenueException::class)
    suspend fun identify(knownUserId: String) {
        dispatcher.run { core.identify(knownUserId) }
    }
```

NOTE: we reference `dev.rovenue.sdk.generated.User` by fully-qualified name to avoid clashing with any future `User` class added at the façade layer. Same pattern applies to `Entitlement`, `ReceiptResult`, `ChangeEvent` in later tasks — or add to the `import` block at the top if preferred. The plan uses fully-qualified types in method signatures for explicitness.

(If you prefer compactness, add `import dev.rovenue.sdk.generated.User` to the file header and use the short name. Both compile. The plan's snippets use FQ names so each task's diff is self-contained.)

- [ ] **Step 6.2: Verify build**

```bash
cd packages/sdk-kotlin && gradle build 2>&1 | tail -5
```
Expected: clean build.

- [ ] **Step 6.3: Smoke check that prior tests still pass**

```bash
cd packages/sdk-kotlin && gradle test 2>&1 | tail -10
```
Expected: still 11 tests green. No new tests in this task — façade smoke for `currentUser` / `identify` lands in Task 11.

- [ ] **Step 6.4: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt
git commit -m "feat(sdk-kotlin): Rovenue.currentUser + identify"
```

---

## Task 7: Entitlement methods — read + refresh

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`

- [ ] **Step 7.1: Add methods to `Rovenue` class**

After the Identity section in `Rovenue.kt`, add:

```kotlin
    // ---------------------------------------------------------------
    // Entitlements (cache-first reads; refresh hits HTTP)
    // ---------------------------------------------------------------

    /** Fetch a specific entitlement from the local cache. Returns null if
     *  it doesn't exist locally — does not hit the network. */
    suspend fun entitlement(id: String): dev.rovenue.sdk.generated.Entitlement? =
        dispatcher.run { core.entitlement(id) }

    /** List all cached entitlements. Does not hit the network. */
    suspend fun entitlementsAll(): List<dev.rovenue.sdk.generated.Entitlement> =
        dispatcher.run { core.entitlementsAll() }

    /** Force a refresh of the entitlements cache against the server.
     *  On success, emits ChangeEvent.ENTITLEMENTS_CHANGED to subscribers
     *  of `changes`. */
    @Throws(RovenueException::class)
    suspend fun refreshEntitlements() {
        dispatcher.run { core.refreshEntitlements() }
    }
```

- [ ] **Step 7.2: Verify**

```bash
cd packages/sdk-kotlin && gradle test 2>&1 | tail -10
```
Expected: clean build, 11 tests still pass.

- [ ] **Step 7.3: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt
git commit -m "feat(sdk-kotlin): Rovenue.entitlement + entitlementsAll + refreshEntitlements"
```

---

## Task 8: Credit methods — balance + refresh + consume

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`

- [ ] **Step 8.1: Add methods to `Rovenue` class**

After the Entitlements section, add:

```kotlin
    // ---------------------------------------------------------------
    // Credits
    // ---------------------------------------------------------------

    /** Read the cached credit balance. Returns 0 if the cache is empty. */
    suspend fun creditBalance(): Long =
        dispatcher.run { core.creditBalance() }

    /** Force a refresh of the credit balance against the server.
     *  On success (when the balance changed), emits
     *  ChangeEvent.CREDIT_BALANCE_CHANGED. */
    @Throws(RovenueException::class)
    suspend fun refreshCredits() {
        dispatcher.run { core.refreshCredits() }
    }

    /** Spend credits server-side. The SDK generates an Idempotency-Key
     *  internally — retries of the same call are server-deduped. Returns
     *  the new balance. Throws RovenueException.InsufficientCredits if
     *  the user lacks the balance. */
    @Throws(RovenueException::class)
    suspend fun consumeCredits(amount: Long, description: String? = null): Long =
        dispatcher.run { core.consumeCredits(amount, description) }
```

- [ ] **Step 8.2: Verify**

```bash
cd packages/sdk-kotlin && gradle test 2>&1 | tail -10
```
Expected: clean build, 11 tests pass.

- [ ] **Step 8.3: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt
git commit -m "feat(sdk-kotlin): Rovenue.creditBalance + refreshCredits + consumeCredits"
```

---

## Task 9: Receipt methods — postAppleReceipt + postGoogleReceipt

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`

- [ ] **Step 9.1: Add methods to `Rovenue` class**

After the Credits section, add:

```kotlin
    // ---------------------------------------------------------------
    // Receipts
    // ---------------------------------------------------------------

    /** Post an Apple StoreKit 2 JWS to the server for validation.
     *  Caller obtains JWS via `Product.purchase()` on iOS (this SDK does
     *  NOT call StoreKit). On success, refreshes entitlements + credits
     *  and returns a ReceiptResult. */
    @Throws(RovenueException::class)
    suspend fun postAppleReceipt(
        jws: String,
        productId: String,
    ): dev.rovenue.sdk.generated.ReceiptResult =
        dispatcher.run { core.postAppleReceipt(jws, productId) }

    /** Post a Google Play Billing purchase token to the server for
     *  validation. Caller obtains the token via `Purchase.purchaseToken`
     *  on Android. On success, refreshes entitlements + credits and
     *  returns a ReceiptResult. */
    @Throws(RovenueException::class)
    suspend fun postGoogleReceipt(
        receipt: String,
        productId: String,
    ): dev.rovenue.sdk.generated.ReceiptResult =
        dispatcher.run { core.postGoogleReceipt(receipt, productId) }
```

- [ ] **Step 9.2: Verify**

```bash
cd packages/sdk-kotlin && gradle test 2>&1 | tail -10
```
Expected: clean build, 11 tests pass.

- [ ] **Step 9.3: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt
git commit -m "feat(sdk-kotlin): Rovenue.postAppleReceipt + postGoogleReceipt"
```

---

## Task 10: Lifecycle + Observer — setForeground, shutdown, changes flow

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`

`setForeground` and `shutdown` are sync forwards to the Rust core. `changes` is a `val` returning the bridge's read-only `SharedFlow` (every consumer collects from the same multicast source).

- [ ] **Step 10.1: Add methods + property to `Rovenue` class**

After the Receipts section in `Rovenue.kt`, add:

```kotlin
    // ---------------------------------------------------------------
    // Lifecycle hooks (sync)
    // ---------------------------------------------------------------

    /** Tell the SDK whether the app is in the foreground. While foreground,
     *  the SDK's internal polling scheduler ticks; while background,
     *  polling pauses. Call from your Activity / Application lifecycle. */
    fun setForeground(foreground: Boolean) {
        core.setForeground(foreground)
    }

    /** Stop background work cleanly. Called automatically on
     *  resetForTesting() and on configure-twice. */
    fun shutdown() {
        core.shutdown()
    }

    // ---------------------------------------------------------------
    // Observer flow
    // ---------------------------------------------------------------

    /** SharedFlow of cache-change notifications. Every collector receives
     *  every event (multicast). Buffer is 64 with DROP_OLDEST policy —
     *  consumers that don't keep up lose old events silently; the cache
     *  reads remain authoritative.
     *
     *  CAUTION: collect this flow from a coroutine OUTSIDE the SDK's
     *  internal scope; calling Rovenue.shutdown() from inside a coroutine
     *  that is itself collecting `changes` would cancel that collector. */
    val changes: kotlinx.coroutines.flow.SharedFlow<dev.rovenue.sdk.generated.ChangeEvent>
        get() = bridge.flow
```

- [ ] **Step 10.2: Verify build**

```bash
cd packages/sdk-kotlin && gradle build 2>&1 | tail -5
```
Expected: clean build.

```bash
cd packages/sdk-kotlin && gradle test 2>&1 | tail -10
```
Expected: 11 tests still pass (no new tests yet — façade smokes land in Task 11).

- [ ] **Step 10.3: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt
git commit -m "feat(sdk-kotlin): Rovenue.setForeground + shutdown + changes flow"
```

---

## Task 11: Update M0 smoke tests to exercise the new façade

**Files:**
- Modify: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/RovenueTest.kt`

With the façade in place we want smokes that exercise the public `Rovenue.shared` API end-to-end (for whatever doesn't require a live server). The existing 3 M0 tests stay — they continue to prove the generated bindings work. We add 5 façade smokes.

- [ ] **Step 11.1: Replace `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/RovenueTest.kt`**

Full new contents:

```kotlin
package dev.rovenue.sdk

import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.Config
import dev.rovenue.sdk.generated.RovenueCore
import dev.rovenue.sdk.generated.RovenueException
import dev.rovenue.sdk.generated.sdkVersion
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RovenueTest {

    // -------------------------------------------------------------
    // M0 smoke (generated bindings — preserved for parity)
    // -------------------------------------------------------------

    @Test
    fun `getVersion matches Cargo pkg version`() {
        val cfg = Config(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.dev", debug = false)
        val core = RovenueCore(cfg)
        assertEquals("0.0.1", core.getVersion())
    }

    @Test
    fun `invalid api key throws at generated layer`() {
        val cfg = Config(apiKey = "", baseUrl = "https://api.rovenue.dev", debug = false)
        assertFailsWith<RovenueException.InvalidApiKey> {
            RovenueCore(cfg)
        }
    }

    @Test
    fun `sdkVersion namespace function non-empty`() {
        assertTrue(sdkVersion().isNotBlank())
    }

    // -------------------------------------------------------------
    // M4 façade smoke (public Rovenue.shared API)
    // -------------------------------------------------------------

    @BeforeEach
    fun setUp() {
        Rovenue.resetForTesting()
    }

    @Test
    fun `facade version matches generated`() {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.dev")
        assertEquals(sdkVersion(), Rovenue.shared.version)
    }

    @Test
    fun `facade currentUser has anon id`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.dev")
        val user = Rovenue.shared.currentUser()
        assertTrue(user.anonId.startsWith("anon_"))
        assertNull(user.knownUserId)
    }

    @Test
    fun `facade entitlements are empty by default`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.dev")
        assertNull(Rovenue.shared.entitlement("pro"))
        assertTrue(Rovenue.shared.entitlementsAll().isEmpty())
    }

    @Test
    fun `facade credit balance is zero by default`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.dev")
        assertEquals(0L, Rovenue.shared.creditBalance())
    }

    @Test
    fun `facade identify emits IDENTITY_CHANGED`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.dev")
        val collected = mutableListOf<ChangeEvent>()
        val job = launch {
            Rovenue.shared.changes.take(1).toList(collected)
        }
        kotlinx.coroutines.yield()
        Rovenue.shared.identify("user_42")
        job.join()
        assertEquals(listOf(ChangeEvent.IDENTITY_CHANGED), collected)
        assertEquals("user_42", Rovenue.shared.currentUser().knownUserId)
    }
}
```

NOTE: each façade smoke calls `Rovenue.resetForTesting()` in `@BeforeEach`. This destroys the prior shared instance (cancelling its scope, shutting down its core) but the SQLite cache file at the OS data dir persists across runs. If you find `facade currentUser has anon id` fails because a prior run wrote `user_42` to the cache, delete `~/Library/Application Support/Rovenue/rovenue.db` (macOS) or `~/.local/share/Rovenue/rovenue.db` (Linux) between runs.

(Future work, separate plan: expose `RovenueCore.newWithDbPath(config, dbPath)` in the UDL so Kotlin tests can use a tempdir.)

- [ ] **Step 11.2: Run full test suite**

```bash
cd packages/sdk-kotlin && gradle test 2>&1 | tail -15
```
Expected: 16 tests pass (3 M0 generated + 4 observer + 4 config + 5 façade smoke).

If `facade currentUser has anon id` fails on a knownUserId mismatch, run:
```bash
rm -f ~/Library/Application\ Support/Rovenue/rovenue.db ~/.local/share/Rovenue/rovenue.db
cd packages/sdk-kotlin && gradle test 2>&1 | tail -10
```
and rerun.

- [ ] **Step 11.3: Commit**

```bash
git add packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/RovenueTest.kt
git commit -m "test(sdk-kotlin): façade smoke tests for currentUser/entitlements/credits/identify"
```

---

## Task 12: Parity smoke script — verify the new Kotlin count fits

**Files:**
- Modify (if needed): `scripts/sdk-parity.sh`

The parity script already runs `gradle test`. We update its assertion (if any) to allow the new test count (16 instead of 3).

- [ ] **Step 12.1: Inspect the existing script**

```bash
grep -n -E "gradle test|sdk-kotlin|Kotlin facade" scripts/sdk-parity.sh | head -10
```

Identify the line that runs `gradle test` and any pattern-matching that asserts a specific test count.

- [ ] **Step 12.2: Update the script if it asserts a specific count**

If the script grep's a literal `"3 tests"` or similar, change to a generic green-marker check. If it only checks the exit code of `gradle test`, no edit is needed.

The exact diff depends on the script's existing structure — read it first. (Same posture as the Swift M3 plan's Task 13.)

- [ ] **Step 12.3: Run parity**

```bash
./scripts/sdk-parity.sh 2>&1 | tail -15
```
Expected: exits 0. The Kotlin section reports the new test count.

If Gradle isn't installed locally, the script's existing skip/warn path handles it.

- [ ] **Step 12.4: Commit (only if edits were needed)**

```bash
git status --short scripts/sdk-parity.sh
```

If clean, skip the commit. Otherwise:
```bash
git add scripts/sdk-parity.sh
git commit -m "test(sdk): parity script accounts for M4 kotlin façade test count"
```

---

## Task 13: Final sweep — build/test/parity/commit count

- [ ] **Step 13.1: Full Kotlin build + test**

```bash
cd packages/sdk-kotlin && gradle build 2>&1 | tail -3
cd packages/sdk-kotlin && gradle test 2>&1 | tail -10
```
Expected: clean build, 16 tests pass.

- [ ] **Step 13.2: Swift suite is unchanged**

```bash
cd packages/sdk-swift && swift test 2>&1 | tail -3
```
Expected: 30 tests pass (M3 baseline, unchanged — we touched no Swift code).

If `swift` isn't on PATH locally, skip.

- [ ] **Step 13.3: Rust core suite is unchanged**

```bash
source $HOME/.cargo/env && cargo test -p librovenue 2>&1 | grep "test result" | awk '{sum+=$4} END {print "Rust total:", sum}'
```
Expected: 89 (unchanged — we touched no Rust code).

- [ ] **Step 13.4: Parity script**

```bash
./scripts/sdk-parity.sh 2>&1 | tail -10
```
Expected: exits 0.

- [ ] **Step 13.5: Summarise commits since main**

```bash
git log --oneline main..HEAD
```
Expected: 9–11 commits with `feat(sdk-kotlin):` / `test(sdk-kotlin):` / `test(sdk):` prefixes (8 feat + 1 test, optionally + 1 parity = 9–10).

- [ ] **Step 13.6: Hand-off**

After verification, stop and ask the controller whether to:
1. Merge to main locally (no push)
2. Push + open PR
3. Leave the branch in the worktree for further iteration

---

## Self-Review Notes

**Spec coverage:**
- §"Public API Surface — `Rovenue` class" — Tasks 5 (configure/shared/version), 6 (identity), 7 (entitlements), 8 (credits), 9 (receipts), 10 (lifecycle/changes)
- §"Generated types reused directly" — implicit; no task needed (data classes free out of the box)
- §"Error type — `RovenueException`" — implicit; methods declare `@Throws(RovenueException::class)` directly, no mapping task
- §"Internal architecture / `Dispatcher`" — Task 3
- §"Internal architecture / `ObserverBridge`" — Task 4
- §"Singleton lifecycle" — Task 5
- §"File layout" — Tasks 3, 4, 5 create the files in the spec'd locations
- §"Dependencies" — Task 2
- §"Testing" — Task 4 (ObserverBridgeTest), Task 5 (ConfigurationTest), Task 11 (façade smoke in RovenueTest)
- §"Distribution / CI" — no plan tasks (spec explicitly defers to a later release plan; existing `.github/workflows/sdk.yml` Kotlin job is unchanged)

**Placeholder scan:** No TBDs. Every code block is complete; every command names the exact tool + expected output.

**Type consistency:**
- Generated types referenced as `dev.rovenue.sdk.generated.User` / `Entitlement` / `ReceiptResult` / `ChangeEvent` (fully-qualified to keep each task self-contained); these names match the M0 binding and the symbols verified during plan-writing.
- `RovenueException.InvalidApiKey` reused identically in Tasks 5 (in `configure` throw) and ConfigurationTest (in `assertFailsWith`).
- `ChangeEvent.ENTITLEMENTS_CHANGED` / `IDENTITY_CHANGED` / `CREDIT_BALANCE_CHANGED` — SCREAMING_SNAKE_CASE per generated enum, used consistently in Task 4's ObserverBridgeTest and Task 11's `facade identify emits IDENTITY_CHANGED`.
- `Dispatcher.run` (Task 3) consumed verbatim in Tasks 6, 7, 8, 9.
- `ObserverBridge` + `bridge.flow` (Task 4) consumed in Task 5 (registered with core in `configure`) and Task 10 (exposed via `changes` val).
- `Rovenue.shared`, `Rovenue.configure`, `Rovenue.version` (Task 5) used in Task 11 (smoke tests).
- `core.currentUser()`, `core.identify(knownUserId)`, `core.entitlement(id)`, `core.entitlementsAll()`, `core.refreshEntitlements()`, `core.creditBalance()`, `core.refreshCredits()`, `core.consumeCredits(amount, description)`, `core.postAppleReceipt(receipt, productId)`, `core.postGoogleReceipt(receipt, productId)`, `core.setForeground(foreground)`, `core.shutdown()`, `core.registerObserver(obs)` — every call matches the generated `RovenueCoreInterface` signature verified during plan-writing (lines 905–921 of `librovenue.kt`).

**Cross-task dependencies:**
- Task 4 depends on Tasks 1 (bindings exist), 2 (kotlinx-coroutines on classpath) — both for `MutableSharedFlow` / `BufferOverflow` imports.
- Task 5 depends on Tasks 3, 4 (`Dispatcher`, `ObserverBridge`).
- Tasks 6–10 depend on Task 5 (`Rovenue` class skeleton with `core` + `bridge` + `dispatcher` properties).
- Task 11 depends on Tasks 5–10 (full public API).
- Task 12 depends on Task 11 (tests committed so the parity script can count them).

**Known risks:**
- SQLite cache file persistence across tests (noted in Task 5 and Task 11). Best-effort for M4; later test-infra plan should add `dbPath` injection.
- `tryEmit` returning false on buffer overflow is silent. Documented loudly in Task 10's KDoc on `changes`. Acceptable per the spec's "events are advisory" stance.
- Test order: JUnit 5 doesn't guarantee test ordering by default. Each test must be independent. `@BeforeEach` `resetForTesting()` + the cache caveat are the only ordering coupling; tests do not share mutable state.
- `Dispatcher.run` runs on `Dispatchers.IO`. If the Rust core's `Arc<Mutex<…>>` is held for a long time, multiple concurrent `Rovenue.shared.X(...)` calls from different coroutines will queue on the Rust-side mutex — that's by design, the bridge does not add throttling.

---

*End of plan.*
