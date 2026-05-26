package dev.rovenue.sdk

import dev.rovenue.sdk.generated.Config
import dev.rovenue.sdk.generated.RovenueCore
import dev.rovenue.sdk.generated.RovenueException
import dev.rovenue.sdk.generated.sdkVersion
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class RovenueTest {
    @Test
    fun `getVersion matches Cargo pkg version`() {
        val cfg = Config(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.dev", debug = false)
        val core = RovenueCore(cfg)
        assertEquals("0.0.1", core.getVersion())
    }

    @Test
    fun `invalid api key throws`() {
        val cfg = Config(apiKey = "", baseUrl = "https://api.rovenue.dev", debug = false)
        assertFailsWith<RovenueException.InvalidApiKey> {
            RovenueCore(cfg)
        }
    }

    @Test
    fun `sdkVersion namespace function non-empty`() {
        assertTrue(sdkVersion().isNotBlank())
    }
}
