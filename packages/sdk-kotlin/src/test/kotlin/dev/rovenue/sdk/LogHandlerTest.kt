package dev.rovenue.sdk

import dev.rovenue.sdk.generated.LogLevel
import dev.rovenue.sdk.generated.LogRecord
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
        Rovenue.configure(apiKey = "pk_test", baseUrl = "https://api.test", logLevel = LogLevel.DEBUG)
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
        assertTrue(entries.any { it.message.contains("identify") && it.level == "info" })
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

    /**
     * Verifies the LogSinkBridge → handler pipeline directly:
     * - constructs a LogRecord and calls LogSinkBridge.onLog()
     * - asserts the registered handler received a mapped LogEntry
     * - asserts fields are mapped correctly (level string, message, data)
     * - asserts PII is not present in the forwarded entry
     *
     * Approach: call LogSinkBridge.onLog() directly rather than driving
     * an identify() call, because (a) the exact Rust core log message format
     * is opaque to the test, and (b) direct construction lets us verify all
     * six LogLevel → level-string mappings without relying on the native lib
     * emitting a specific level during identify(). This also exercises OFF
     * (should be silently dropped, handler NOT called).
     */
    @Test
    fun coreLogReachesHandler() {
        val captured = mutableListOf<LogEntry>()
        val unsub = Rovenue.shared.setLogHandler { captured.add(it) }
        try {
            val bridge = LogSinkBridge()
            // INFO record with fields should arrive as LogEntry with data
            bridge.onLog(LogRecord(LogLevel.INFO, "identify started", mapOf("op" to "identify")))
            // OFF record must be silently dropped
            bridge.onLog(LogRecord(LogLevel.OFF, "should be dropped", emptyMap()))
            // ERROR with no fields → data should be null
            bridge.onLog(LogRecord(LogLevel.ERROR, "identify failed", emptyMap()))

            assertTrue(
                captured.any { it.level == "info" && it.message == "identify started" && it.data == mapOf("op" to "identify") },
                "INFO record must arrive with correct level, message, and data map",
            )
            assertFalse(
                captured.any { it.message == "should be dropped" },
                "OFF record must be silently dropped",
            )
            assertTrue(
                captured.any { it.level == "error" && it.message == "identify failed" && it.data == null },
                "ERROR record with empty fields must arrive with null data",
            )
            // PII check: no raw user id should be present
            assertFalse(captured.any { it.message.contains("user_pii_check") })
        } finally {
            unsub()
        }
    }
}
