package dev.rovenue.sdk

import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LogHandlerTest {

    @BeforeTest
    fun setup() {
        Rovenue.configure(apiKey = "pk_test", baseUrl = "https://api.test", debug = true)
    }

    @AfterTest
    fun teardown() {
        Rovenue.resetForTesting()
    }

    @Test
    fun handlerReceivesEntries() = runBlocking {
        val captured = mutableListOf<LogEntry>()
        Rovenue.shared.setLogHandler { entry -> synchronized(captured) { captured.add(entry) } }
        runCatching { Rovenue.shared.identify("user_log_test") }
        val entries = synchronized(captured) { captured.toList() }
        assertTrue(entries.isNotEmpty(), "handler should have received entries")
        assertTrue(entries.any { it.message == "identify" && it.level == "info" })
        // Privacy: handler MUST NOT receive the raw knownUserId string.
        assertFalse(entries.any { it.message.contains("user_log_test") })
    }

    @Test
    fun unsubscribeStopsCalls() = runBlocking {
        val captured = mutableListOf<LogEntry>()
        val unsub = Rovenue.shared.setLogHandler { entry -> synchronized(captured) { captured.add(entry) } }
        unsub()
        runCatching { Rovenue.shared.identify("user_unsub_test") }
        assertEquals(0, synchronized(captured) { captured.size })
    }
}
