package dev.rovenue.sdk

import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.Config
import dev.rovenue.sdk.generated.ErrorKind
import dev.rovenue.sdk.generated.LogLevel
import dev.rovenue.sdk.generated.RovenueCore
import dev.rovenue.sdk.generated.RovenueErrorFfi
import dev.rovenue.sdk.generated.sdkVersion
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RovenueTest {

    // -------------------------------------------------------------
    // M0 smoke (generated bindings — preserved for parity)
    // -------------------------------------------------------------

    @Test
    fun `getVersion matches Cargo pkg version`() {
        val cfg = Config(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.io", logLevel = LogLevel.WARN, appVersion = null, platform = null, environment = null)
        val core = RovenueCore(cfg)
        // core.getVersion() reports the librovenue crate version (workspace
        // version), which is the same value the namespace sdkVersion() returns.
        assertEquals(sdkVersion(), core.getVersion())
    }

    @Test
    fun `invalid api key throws at generated layer`() {
        val cfg = Config(apiKey = "", baseUrl = "https://api.rovenue.io", logLevel = LogLevel.WARN, appVersion = null, platform = null, environment = null)
        val ex = assertFailsWith<RovenueErrorFfi.Generic> {
            RovenueCore(cfg)
        }
        assertEquals(ErrorKind.INVALID_API_KEY, ex.kind)
    }

    @Test
    fun `sdkVersion namespace function non-empty`() {
        assertTrue(sdkVersion().isNotBlank())
    }

    // -------------------------------------------------------------
    // M4 façade smoke (public Rovenue.shared API)
    // -------------------------------------------------------------

    @BeforeEach
    fun setUp() {
        Rovenue.resetForTesting()
        TestSupport.wipeCoreCache()
    }

    @Test
    fun `facade version matches generated`() {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.io")
        assertEquals(sdkVersion(), Rovenue.shared.version)
    }

    @Test
    fun `facade currentUser has anon id`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.io")
        val user = Rovenue.shared.currentUser()
        assertTrue(user.rovenueId.startsWith("rov_"))
        assertNull(user.appUserId)
    }

    @Test
    fun `facade entitlements are empty by default`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.io")
        assertNull(Rovenue.shared.entitlement("pro"))
        assertTrue(Rovenue.shared.entitlementsAll().isEmpty())
    }

    @Test
    fun `facade virtual currency balances are empty by default`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.io")
        assertTrue(Rovenue.shared.virtualCurrencyBalances().isEmpty())
    }

    // NOTE: This test uses runBlocking instead of runTest. The Rust observer
    // callback fires on a real Rust thread (real dispatcher), while runTest
    // uses StandardTestDispatcher (virtual time). Mixing the two has caused
    // hangs on cross-thread observer-emit paths. runBlocking keeps the entire
    // test on the real coroutine machinery, matching the production dispatch
    // shape. The other façade smokes don't cross the observer boundary, so
    // they stay on runTest for faster execution.
    @Test
    fun `facade identify emits IDENTITY_CHANGED`() = runBlocking {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://api.rovenue.io")
        val collected = mutableListOf<ChangeEvent>()
        val job = launch {
            Rovenue.shared.changes.take(1).toList(collected)
        }
        kotlinx.coroutines.yield()
        Rovenue.shared.identify("user_42")
        job.join()
        assertEquals(listOf(ChangeEvent.IDENTITY_CHANGED), collected)
        assertEquals("user_42", Rovenue.shared.currentUser().appUserId)
    }
}
