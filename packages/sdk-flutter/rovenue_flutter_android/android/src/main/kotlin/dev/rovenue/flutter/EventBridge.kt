// EventBridge.kt — forwards the Kotlin façade's async event sources
// (`Rovenue.shared.changes`, `Rovenue.shared.funnelClaims`, and the log
// handler registered via `Rovenue.shared.setLogHandler`) onto the
// Pigeon-generated `RovenueFlutterApi` (Dart-bound `onChange` / `onLog` /
// `onFunnelClaim`).
//
// Subscribed exactly once, from `HostApiImpl.configure(...)` — mirrors
// `RovenueModule.kt`'s `OnStartObserving`/`OnStopObserving` pair (minus the
// Expo view-lifecycle hooks Pigeon has no equivalent for) and Task 4's
// Swift `EventBridge.swift`: `start()` is idempotent (a second call tears
// down the prior subscriptions first) so a repeated `configure()` call
// never double-delivers events.

package dev.rovenue.flutter

import dev.rovenue.sdk.Rovenue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect

class EventBridge(
    private val flutterApi: RovenueFlutterApi,
    private val scope: CoroutineScope,
) {
    private var changesJob: Job? = null
    private var funnelClaimsJob: Job? = null
    private var logUnsub: (() -> Unit)? = null

    /** Subscribes to `changes`/`funnelClaims`/log handler. Idempotent: a
     *  second call tears down the prior subscriptions first so events are
     *  never delivered twice after a repeat `configure()`. */
    fun start() {
        stop()

        changesJob = scope.launch {
            Rovenue.shared.changes.collect { event ->
                val dto = mapChangeEvent(event)
                launchOnMain { flutterApi.onChange(dto) {} }
            }
        }

        funnelClaimsJob = scope.launch {
            Rovenue.shared.funnelClaims.collect { claim ->
                val dto = mapFunnelClaim(claim)
                launchOnMain { flutterApi.onFunnelClaim(dto) {} }
            }
        }

        logUnsub = Rovenue.shared.setLogHandler { entry ->
            val dto = mapLogRecord(entry)
            launchOnMain { flutterApi.onLog(dto) {} }
        }
    }

    fun stop() {
        changesJob?.cancel()
        changesJob = null
        funnelClaimsJob?.cancel()
        funnelClaimsJob = null
        logUnsub?.invoke()
        logUnsub = null
    }

    /** `RovenueFlutterApi`'s generated `send()` calls must run on the
     *  platform (main) thread — the `BasicMessageChannel` it wraps is not
     *  thread-safe. `changes`/`funnelClaims` are collected on this class's
     *  own scope (main-dispatcher by construction, see
     *  `RovenueFlutterAndroidPlugin.kt`), so this hop only matters for the
     *  synchronous `setLogHandler` callback, which the façade may invoke
     *  from a background thread. */
    private fun launchOnMain(block: () -> Unit) {
        scope.launch(Dispatchers.Main.immediate) { block() }
    }
}
