package dev.rovenue.sdk

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.UUID

class AppAccountTokenTest {
    @BeforeEach
    fun setup() {
        Rovenue.resetForTesting()
        Rovenue.configure(apiKey = "test_pk", baseUrl = "http://localhost:0", debug = true)
    }

    @AfterEach
    fun teardown() {
        Rovenue.resetForTesting()
    }

    @Test
    fun returnsStableUuidAcrossCalls() = runBlocking {
        val t1 = Rovenue.shared.getAppAccountToken()
        val t2 = Rovenue.shared.getAppAccountToken()
        assertEquals(t1, t2)
        assertNotNull(UUID.fromString(t1))
    }

    @Test
    fun tokenIsScopedPerIdentify() = runBlocking {
        val anon = Rovenue.shared.getAppAccountToken()
        Rovenue.shared.identify("user-456")
        val known = Rovenue.shared.getAppAccountToken()
        assertNotEquals(anon, known)
    }
}
