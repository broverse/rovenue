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
     * never crash the app) and clears the flag via [kotlinx.coroutines.Job.invokeOnCompletion],
     * which runs on every terminal state — normal, exception, or scope-cancelled
     * before the body starts — so the flag can never wedge.
     */
    fun fire(scope: CoroutineScope, block: suspend () -> Unit) {
        if (!inFlight.compareAndSet(false, true)) return
        val job = scope.launch {
            try {
                block()
            } catch (c: kotlin.coroutines.cancellation.CancellationException) {
                throw c // preserve structured concurrency
            } catch (t: Throwable) {
                // best-effort; never crash the app on a foreground reconcile
            }
        }
        // Clear on every terminal state — including a job cancelled before its
        // body runs, where the in-coroutine finally would never execute.
        job.invokeOnCompletion { inFlight.set(false) }
    }
}
