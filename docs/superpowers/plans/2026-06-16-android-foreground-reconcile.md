# Android Foreground Purchase Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Android SDK automatically re-run `reconcilePurchases()` whenever the app process enters the foreground (parity with iOS's always-on `Transaction.updates`), with no host-app wiring.

**Architecture:** A small coalescing trigger (`ForegroundReconcileTrigger`) plus a thin `DefaultLifecycleObserver` (`ForegroundReconcileObserver`) auto-registered against `ProcessLifecycleOwner` at `configure()` time. On each app foreground (`onStart`), the observer fires the trigger, which launches `reconcilePurchases()` on the existing background scope unless one is already in flight. No core, iOS, or Swift changes; no SQLite outbox.

**Tech Stack:** Kotlin, kotlinx-coroutines, androidx.lifecycle (ProcessLifecycleOwner), JUnit5, kotlinx-coroutines-test, MockK, Robolectric.

**Spec:** `docs/superpowers/specs/2026-06-16-android-foreground-reconcile-design.md`

**Environment note:** Stay on the current git branch (do not create/switch branches). A parallel agent is editing `apps/...`; touch only `packages/sdk-kotlin/...`, stage by exact path, and commit with pathspec (`git add <paths>` then `git commit <paths> -m ...`). End every commit message body with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/sdk-kotlin/build.gradle.kts` | Module deps | Add `androidx.lifecycle:lifecycle-process` |
| `.../internal/ForegroundReconcileTrigger.kt` | Coalesce + best-effort launch | New |
| `.../internal/ForegroundReconcileObserver.kt` | Lifecycle → trigger adapter | New |
| `.../Rovenue.kt` | Wire observer at configure, remove at shutdown, route post-configure reconcile through trigger | Modify |
| `.../test/.../ForegroundReconcileTriggerTest.kt` | Unit tests for trigger + observer | New |

Full Kotlin package path for `internal`:
`packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/`
Test path: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/`

---

## Task 1: `ForegroundReconcileTrigger` (coalescing core)

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ForegroundReconcileTrigger.kt`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ForegroundReconcileTriggerTest.kt`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ForegroundReconcileTriggerTest.kt`:

```kotlin
package dev.rovenue.sdk

import dev.rovenue.sdk.internal.ForegroundReconcileTrigger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals

class ForegroundReconcileTriggerTest {

    @Test
    fun `concurrent fires coalesce into one run`() = runTest {
        val trigger = ForegroundReconcileTrigger()
        val runs = AtomicInteger(0)
        val gate = CompletableDeferred<Unit>()

        // First fire claims the in-flight slot synchronously; second is dropped.
        trigger.fire(this) { runs.incrementAndGet(); gate.await() }
        trigger.fire(this) { runs.incrementAndGet(); gate.await() }

        runCurrent() // start the first coroutine; it parks on the gate
        assertEquals(1, runs.get())

        gate.complete(Unit)
        advanceUntilIdle() // first run finishes, flag cleared

        // A later fire runs again now that the slot is free.
        trigger.fire(this) { runs.incrementAndGet() }
        advanceUntilIdle()
        assertEquals(2, runs.get())
    }

    @Test
    fun `throwing block is swallowed and clears the in-flight flag`() = runTest {
        val trigger = ForegroundReconcileTrigger()
        val runs = AtomicInteger(0)

        trigger.fire(this) { runs.incrementAndGet(); throw RuntimeException("boom") }
        advanceUntilIdle() // exception swallowed inside fire(); flag cleared in finally

        trigger.fire(this) { runs.incrementAndGet() }
        advanceUntilIdle()
        assertEquals(2, runs.get())
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew -p packages/sdk-kotlin test --tests "dev.rovenue.sdk.ForegroundReconcileTriggerTest"`
Expected: FAIL — `ForegroundReconcileTrigger` does not exist (unresolved reference / compile error).

- [ ] **Step 3: Implement `ForegroundReconcileTrigger`**

Create `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ForegroundReconcileTrigger.kt`:

```kotlin
package dev.rovenue.sdk.internal

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Coalesces foreground-triggered reconciliations: while one run is in flight,
 * further fires are dropped. Decoupled from any lifecycle owner so it is
 * unit-testable without Android lifecycle infrastructure.
 */
internal class ForegroundReconcileTrigger {
    private val inFlight = AtomicBoolean(false)

    /**
     * Launches [block] on [scope] unless a run is already in flight. Swallows
     * non-cancellation failures (foreground reconcile is best-effort and must
     * never crash the app) and clears the flag in `finally`, so a failed or
     * cancelled run never wedges it.
     */
    fun fire(scope: CoroutineScope, block: suspend () -> Unit) {
        if (!inFlight.compareAndSet(false, true)) return
        scope.launch {
            try {
                block()
            } catch (c: kotlin.coroutines.cancellation.CancellationException) {
                throw c // preserve structured concurrency
            } catch (t: Throwable) {
                // best-effort; never crash the app on a foreground reconcile
            } finally {
                inFlight.set(false)
            }
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew -p packages/sdk-kotlin test --tests "dev.rovenue.sdk.ForegroundReconcileTriggerTest"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ForegroundReconcileTrigger.kt \
        packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ForegroundReconcileTriggerTest.kt
git commit packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ForegroundReconcileTrigger.kt \
           packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ForegroundReconcileTriggerTest.kt \
  -m "feat(sdk-kotlin): coalescing ForegroundReconcileTrigger

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `ForegroundReconcileObserver` (lifecycle adapter)

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ForegroundReconcileObserver.kt`
- Modify: `packages/sdk-kotlin/build.gradle.kts`
- Test: append to `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ForegroundReconcileTriggerTest.kt`

- [ ] **Step 1: Add the `lifecycle-process` dependency**

In `packages/sdk-kotlin/build.gradle.kts`, inside the `dependencies { }` block, add this line
after the existing `implementation("com.android.billingclient:billing-ktx:6.2.0")` line:

```gradle
    implementation("androidx.lifecycle:lifecycle-process:2.6.2")
```

- [ ] **Step 2: Write the failing test for the observer**

Append a second test class to
`packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ForegroundReconcileTriggerTest.kt`
(below the existing `ForegroundReconcileTriggerTest` class, same file). It drives the observer
with a mocked `LifecycleOwner` and asserts each `onStart` invokes the callback once:

```kotlin
class ForegroundReconcileObserverTest {

    @Test
    fun `onStart invokes the callback each time`() {
        val calls = AtomicInteger(0)
        val observer = ForegroundReconcileObserver { calls.incrementAndGet() }
        val owner = mockk<androidx.lifecycle.LifecycleOwner>()

        observer.onStart(owner)
        observer.onStart(owner)

        assertEquals(2, calls.get())
    }
}
```

This second class reuses the file's existing imports (`kotlin.test.Test`,
`kotlin.test.assertEquals`, `java.util.concurrent.atomic.AtomicInteger`) and adds two more at
the top of the file:

```kotlin
import dev.rovenue.sdk.internal.ForegroundReconcileObserver
import io.mockk.mockk
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./gradlew -p packages/sdk-kotlin test --tests "dev.rovenue.sdk.ForegroundReconcileObserverTest"`
Expected: FAIL — `ForegroundReconcileObserver` does not exist.

- [ ] **Step 4: Implement `ForegroundReconcileObserver`**

Create `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ForegroundReconcileObserver.kt`:

```kotlin
package dev.rovenue.sdk.internal

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/**
 * Fires [onForeground] each time the app process enters the foreground
 * (`ON_START`). Registered against `ProcessLifecycleOwner` by [dev.rovenue.sdk.Rovenue].
 */
internal class ForegroundReconcileObserver(
    private val onForeground: () -> Unit,
) : DefaultLifecycleObserver {
    override fun onStart(owner: LifecycleOwner) {
        onForeground()
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `./gradlew -p packages/sdk-kotlin test --tests "dev.rovenue.sdk.ForegroundReconcileObserverTest"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-kotlin/build.gradle.kts \
        packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ForegroundReconcileObserver.kt \
        packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ForegroundReconcileTriggerTest.kt
git commit packages/sdk-kotlin/build.gradle.kts \
           packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ForegroundReconcileObserver.kt \
           packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ForegroundReconcileTriggerTest.kt \
  -m "feat(sdk-kotlin): ForegroundReconcileObserver + lifecycle-process dep

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire the observer into `Rovenue` lifecycle

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`

Current relevant code (for reference):
- Imports block ends around line 33 (`import kotlin.concurrent.withLock`).
- Instance fields + `private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)` at line 65.
- `configure(...)` builds the instance, swaps the singleton, then launches the post-configure
  reconcile (lines 112–129):
  ```kotlin
              val instance = Rovenue(
                  core, bridge, Dispatcher(), appVersion, context?.applicationContext,
              )
              synchronized(lock) {
                  _shared?.shutdownInternal()
                  _shared = instance
              }
              instance.scope.launch {
                  runCatching { instance.reconcilePurchases() }
              }
  ```
- `shutdownInternal()` at lines 171–174:
  ```kotlin
      private fun shutdownInternal() {
          scope.cancel()
          core.shutdown()
      }
  ```

- [ ] **Step 1: Add imports**

In `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`, add these imports (place
the `android.os.*` ones near the existing `import android.content.Context` at line 12, the
`androidx` one alphabetically after, and the `internal` ones with the other
`dev.rovenue.sdk.internal.*` imports):

```kotlin
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.ProcessLifecycleOwner
import dev.rovenue.sdk.internal.ForegroundReconcileObserver
import dev.rovenue.sdk.internal.ForegroundReconcileTrigger
```

- [ ] **Step 2: Add instance fields**

Immediately after the `scope` field (line 65), add:

```kotlin
    // Coalesces foreground-triggered reconciliations (post-configure + every
    // app foreground) so overlapping triggers run at most one reconcile.
    private val reconcileTrigger = ForegroundReconcileTrigger()

    // Lifecycle observer driving foreground reconciliation; held so it can be
    // removed on shutdown. Registered/removed on the main thread.
    private var foregroundObserver: ForegroundReconcileObserver? = null
    private val mainHandler = Handler(Looper.getMainLooper())
```

- [ ] **Step 3: Add the register/remove helpers**

Add these two private methods to the `Rovenue` instance (e.g. just above `shutdownInternal()`
at line 171):

```kotlin
    // Registers the ProcessLifecycleOwner observer on the main thread (the
    // lifecycle APIs are main-thread only). Each app foreground fires a
    // coalesced reconcile on the background scope.
    private fun startForegroundReconcile() {
        val observer = ForegroundReconcileObserver {
            reconcileTrigger.fire(scope) { reconcilePurchases() }
        }
        foregroundObserver = observer
        mainHandler.post {
            ProcessLifecycleOwner.get().lifecycle.addObserver(observer)
        }
    }

    private fun stopForegroundReconcile() {
        val observer = foregroundObserver ?: return
        foregroundObserver = null
        mainHandler.post {
            ProcessLifecycleOwner.get().lifecycle.removeObserver(observer)
        }
    }
```

- [ ] **Step 4: Route the post-configure reconcile through the trigger and start the observer**

In `configure(...)`, replace the post-configure launch block:

```kotlin
            instance.scope.launch {
                runCatching { instance.reconcilePurchases() }
            }
```

with:

```kotlin
            // Best-effort startup reconcile + continuous foreground reconcile.
            // Both go through the trigger so they share the in-flight guard.
            instance.startForegroundReconcile()
            instance.reconcileTrigger.fire(instance.scope) { instance.reconcilePurchases() }
```

- [ ] **Step 5: Remove the observer on shutdown**

Update `shutdownInternal()` (lines 171–174) to:

```kotlin
    private fun shutdownInternal() {
        stopForegroundReconcile()
        scope.cancel()
        core.shutdown()
    }
```

- [ ] **Step 6: Build the module**

Run: `./gradlew -p packages/sdk-kotlin compileReleaseKotlin compileDebugKotlin`
Expected: BUILD SUCCESSFUL (resolves `androidx.lifecycle.ProcessLifecycleOwner` and the new
internal classes; `reconcileTrigger`/`startForegroundReconcile` are accessible from the
companion's `configure` because they are instance members on `instance`).

- [ ] **Step 7: Run the full module test suite**

Run: `./gradlew -p packages/sdk-kotlin test`
Expected: BUILD SUCCESSFUL — all existing tests plus the two new test classes pass. (If a
pre-existing unrelated failure appears, note it; do not fix out-of-scope code.)

- [ ] **Step 8: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt
git commit packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt \
  -m "feat(sdk-kotlin): auto-reconcile purchases on app foreground

Registers a ProcessLifecycleOwner observer at configure() that fires a
coalesced reconcilePurchases() on each foreground (parity with iOS's
always-on Transaction.updates); removed on shutdown. Routes the existing
post-configure reconcile through the same in-flight guard.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Step 1: Full Kotlin module build + test**

Run: `./gradlew -p packages/sdk-kotlin build`
Expected: BUILD SUCCESSFUL; new tests green.

- [ ] **Step 2: Confirm spec coverage**

Cross-check `docs/superpowers/specs/2026-06-16-android-foreground-reconcile-design.md`:
- `lifecycle-process` dependency → Task 2 Step 1.
- `ForegroundReconcileTrigger` (coalesce + best-effort catch) → Task 1.
- `ForegroundReconcileObserver` (onStart adapter) → Task 2.
- Register on configure (main thread) + route post-configure through trigger → Task 3 Steps 3–4.
- Remove on shutdown (main thread) → Task 3 Steps 3, 5.
- Tests: trigger coalesce, throwing-block clears flag, observer onStart → Tasks 1–2.
- No core/iOS/Swift changes, no SQLite outbox → confirm nothing outside `packages/sdk-kotlin`
  was touched (`git status --short` shows only sdk-kotlin paths from this work).
