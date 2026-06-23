package dev.rovenue.sdk

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
        assertFailsWith<RovenueException> {
            Rovenue.configure(apiKey = "", baseUrl = "https://api.rovenue.io")
        }
    }

    @Test
    fun `configure rejects whitespace api key`() {
        assertFailsWith<RovenueException> {
            Rovenue.configure(apiKey = "   ", baseUrl = "https://api.rovenue.io")
        }
    }

    @Test
    fun `configure succeeds with valid config`() {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.io")
        assertNotNull(Rovenue.shared)
        assertEquals(sdkVersion(), Rovenue.shared.version)
    }

    @Test
    fun `configure twice replaces shared instance`() {
        Rovenue.configure(apiKey = "pk_first", baseUrl = "https://api.rovenue.io")
        val first = Rovenue.shared
        Rovenue.configure(apiKey = "pk_second", baseUrl = "https://api.rovenue.io")
        val second = Rovenue.shared
        assertNotSame(first, second)
    }

    @Test
    fun `configure succeeds without base url`() {
        // baseUrl omitted → core falls back to the hosted default.
        Rovenue.configure(apiKey = "pk_test_default")
        assertNotNull(Rovenue.shared)
        assertEquals(sdkVersion(), Rovenue.shared.version)
    }
}
