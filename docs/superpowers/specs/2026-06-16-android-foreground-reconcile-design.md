# Android Foreground Purchase Reconciliation — Design

**Date:** 2026-06-16
**Status:** Approved (pending spec review)
**Scope:** `packages/sdk-kotlin` only. No core, iOS, or Swift changes.

## Background

This addresses what was tracked as deferred items **1b** (durable receipt outbox) and
**1c** (Rust-core startup reconcile + identify race) from
`docs/superpowers/specs/2026-06-16-sdk-purchase-freshness-design.md`. Investigation showed
the original framing of those two items was the wrong design:

- **Receipt tokens never live in the Rust core** — they are held by the platform stores
  (StoreKit / Play Billing) and queried by the façades. A core-side SQLite outbox would
  duplicate a durable queue the platform already provides.
- **The platform store is already a crash-safe durable queue + source of truth.** Android
  consumes/acknowledges only *after* a successful server POST
  (`PlayPurchaseFlow.kt:40-41`, consume gated in `PlayBillingStore.kt:297`); the reconciler
  only acknowledges, never consumes (`PurchaseReconciler.kt:20-28`). So there is no window
  where a purchase is finalized locally but lost to the server — a failed POST leaves the
  purchase unacknowledged/unconsumed, and the platform re-surfaces it on the next query.
- **Deterministic idempotency (shipped in the prior feature, `IdempotencyKey::for_receipt`)
  makes concurrent/duplicate re-posts harmless** — same `(store, receipt)` → same key →
  server idempotency replay, plus the DB unique constraint on `(store, storeTransactionId)`.
  This removes the "double POST race" that the `api.rs:164` comment cited as the reason for
  having no startup reconcile.

The one **real** gap: iOS reconciles continuously and automatically via the always-on
`Transaction.updates` listener (`Rovenue.swift:551`), but **Android only reconciles once at
configure** (`Rovenue.kt:124`) — there is no foreground/resume trigger and no lifecycle
observer registered today. A receipt POST that fails after the app is already running only
retries on the next cold start. This design gives Android the same automatic, host-wiring-free
reconciliation iOS already has.

## Goals

- Android automatically re-runs `reconcilePurchases()` when the app returns to the
  foreground, with no host-app wiring required (parity with iOS's always-on listener).
- Safe to fire on every foreground transition (coalesced; idempotent at the server).
- No core changes, no SQLite outbox, no iOS changes.

## Non-Goals

- No core-side `pending_receipts` table / durable outbox (1b as originally framed — rejected).
- No Rust-core startup receipt reconcile (1c as originally framed — unnecessary; receipts are
  façade-reconciled and deterministic idempotency makes races harmless).
- No iOS changes — `Transaction.updates` already delivers unfinished transactions on launch.
- No time-based debounce (YAGNI — steady state is a cheap empty Play query with no POST).

## Architecture

A new Android foreground trigger in `packages/sdk-kotlin` that calls the existing
`reconcilePurchases()` on app foreground. Two small, focused units plus wiring:

### Component 1 — `ForegroundReconcileTrigger` (internal, testable core)

A tiny class holding an in-flight guard, decoupled from `ProcessLifecycleOwner` so it is
unit-testable without Android lifecycle infrastructure.

```kotlin
package dev.rovenue.sdk.internal

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/** Coalesces foreground-triggered reconciliations: while one run is in flight,
 *  further fires are dropped. Decoupled from any lifecycle owner for testing. */
internal class ForegroundReconcileTrigger {
    private val inFlight = AtomicBoolean(false)

    /** Launches [block] on [scope] unless a run is already in flight. The flag
     *  is cleared in `finally`, so a failed/cancelled run never wedges it. */
    fun fire(scope: CoroutineScope, block: suspend () -> Unit) {
        if (!inFlight.compareAndSet(false, true)) return
        scope.launch {
            try {
                block()
            } finally {
                inFlight.set(false)
            }
        }
    }
}
```

### Component 2 — `ForegroundReconcileObserver` (internal, thin lifecycle adapter)

```kotlin
package dev.rovenue.sdk.internal

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/** Fires the reconcile trigger each time the app process enters the foreground. */
internal class ForegroundReconcileObserver(
    private val onForeground: () -> Unit,
) : DefaultLifecycleObserver {
    override fun onStart(owner: LifecycleOwner) {
        onForeground()
    }
}
```

### Component 3 — wiring in `Rovenue`

- Add fields: `private val reconcileTrigger = ForegroundReconcileTrigger()` and
  `private var foregroundObserver: ForegroundReconcileObserver? = null`.
- After the instance is constructed in `configure(...)` (where `appContext` is set and the
  post-configure reconcile is launched), register the observer on the **main thread**
  (`ProcessLifecycleOwner.get()` and `lifecycle.addObserver/removeObserver` are main-thread
  only):

```kotlin
private fun registerForegroundObserver() {
    val observer = ForegroundReconcileObserver {
        reconcileTrigger.fire(scope) {
            runCatching { reconcilePurchases() } // best-effort; never surface errors
        }
    }
    foregroundObserver = observer
    mainHandler.post {
        ProcessLifecycleOwner.get().lifecycle.addObserver(observer)
    }
}
```
where `mainHandler = Handler(Looper.getMainLooper())`.

- In `shutdownInternal()`, before/alongside `scope.cancel()`, remove the observer on the main
  thread:

```kotlin
foregroundObserver?.let { obs ->
    mainHandler.post { ProcessLifecycleOwner.get().lifecycle.removeObserver(obs) }
}
foregroundObserver = null
```

### Dependency

Add to `packages/sdk-kotlin/build.gradle.kts`:

```gradle
implementation("androidx.lifecycle:lifecycle-process:2.6.2")
```

## Data flow

```
app foreground (process ON_START)
  └─ ForegroundReconcileObserver.onStart        [main thread]
       └─ reconcileTrigger.fire(scope) { reconcilePurchases() }
            └─ if already in flight → drop; else launch on scope (Dispatchers.IO)
                 └─ reconcilePurchases()
                      └─ PlayBillingStore.queryUnacknowledgedPurchases()
                      └─ for each: validate(token) [deterministic idempotency key]
                           └─ on success: acknowledge()   (no consume in reconcile)
                 └─ finally: clear in-flight flag

configure(...)  (existing, unchanged)
  └─ scope.launch { runCatching { reconcilePurchases() } }   ← still runs once at startup
```

The existing post-configure reconcile (`Rovenue.kt:124`) stays. If it overlaps with an
`onStart` (e.g. configure called while the app is already foregrounded), the in-flight guard
prevents a duplicate concurrent run. Note: the existing post-configure launch goes straight to
`reconcilePurchases()` (not through the trigger); to share the coalesce guard, route it through
`reconcileTrigger.fire(scope) { runCatching { reconcilePurchases() } }` as part of this change.

## Error handling

- The observer callback must never crash the app: the reconcile body is wrapped in
  `runCatching` (offline / no Play Billing / no `appContext` → silently skipped, matching the
  existing post-configure behavior).
- The in-flight flag is cleared in `finally`, so a thrown/cancelled reconcile never wedges the
  trigger.
- `reconcilePurchases()` already requires `appContext`; if absent it throws, which `runCatching`
  swallows.

## Threading

- `ProcessLifecycleOwner.get()` and `lifecycle.addObserver`/`removeObserver` run on the main
  thread via `mainHandler.post { }` (configure/shutdown may be called from any thread).
- `onStart` is delivered on the main thread; the actual reconcile runs on `scope`
  (`Dispatchers.IO`), so the main thread is never blocked.

## Testing

- **`ForegroundReconcileTrigger` coalescing (unit):** with a real `CoroutineScope` (e.g.
  `TestScope`/`StandardTestDispatcher`), call `fire` twice before the first block completes
  (block suspends on a gate); assert the block body ran exactly once. After the first run
  completes, a third `fire` runs again (flag cleared).
- **`ForegroundReconcileObserver` (unit):** construct with a counter lambda; call
  `onStart(mockOwner)`; assert the lambda fired once per `onStart`.
- **In-flight clears on failure (unit):** a `fire` whose block throws still clears the flag
  (a subsequent `fire` runs). Verifies the `finally`.
- ProcessLifecycleOwner integration itself is not unit-tested (Android framework); the logic
  is fully covered by the decoupled trigger/observer tests.

## Affected files

- `packages/sdk-kotlin/build.gradle.kts` — add `lifecycle-process` dependency.
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ForegroundReconcileTrigger.kt` — new.
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ForegroundReconcileObserver.kt` — new.
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` — fields, `mainHandler`,
  register on configure, remove on shutdown, route post-configure reconcile through the trigger.
- `packages/sdk-kotlin/src/test/.../ForegroundReconcileTriggerTest.kt` (+ observer test) — new.
