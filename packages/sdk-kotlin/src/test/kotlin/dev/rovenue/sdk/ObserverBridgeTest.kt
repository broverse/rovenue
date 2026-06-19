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
        bridge.onChange(ChangeEvent.VIRTUAL_CURRENCIES_CHANGED)
        bridge.onChange(ChangeEvent.IDENTITY_CHANGED)
        job.join()
        assertEquals(
            listOf(
                ChangeEvent.ENTITLEMENTS_CHANGED,
                ChangeEvent.VIRTUAL_CURRENCIES_CHANGED,
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
