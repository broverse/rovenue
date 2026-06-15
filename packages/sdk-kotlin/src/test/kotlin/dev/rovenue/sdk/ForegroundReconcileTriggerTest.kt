package dev.rovenue.sdk

import dev.rovenue.sdk.internal.ForegroundReconcileTrigger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import java.util.concurrent.atomic.AtomicInteger
import org.junit.jupiter.api.Test
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
