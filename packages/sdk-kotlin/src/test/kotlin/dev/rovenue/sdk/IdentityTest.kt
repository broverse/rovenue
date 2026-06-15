package dev.rovenue.sdk

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Phase 6 identity tests: rovenueId/appUserId field contract + logOut().
 *
 * All assertions are client-local (no server calls). configure() points at an
 * unreachable base URL so any accidental network path fails fast instead of
 * hanging.
 */
class IdentityTest {

    @BeforeEach
    fun setUp() {
        Rovenue.resetForTesting()
        TestSupport.wipeCoreCache()
    }

    @Test
    fun `fresh configure yields rov_ rovenueId and null appUserId`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://unreachable.invalid")
        val user = Rovenue.shared.currentUser()
        assertTrue(user.rovenueId.startsWith("rov_"), "rovenueId should start with 'rov_', got: ${user.rovenueId}")
        assertNull(user.appUserId, "appUserId should be null for a fresh anonymous user")
    }

    @Test
    fun `logOut produces new rovenueId and clears appUserId`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://unreachable.invalid")
        val idBefore = Rovenue.shared.currentUser().rovenueId

        // identify() sets appUserId locally
        Rovenue.shared.identify("test_user_99")

        // logOut() resets to a fresh anonymous identity
        Rovenue.shared.logOut()

        val userAfter = Rovenue.shared.currentUser()
        assertTrue(
            userAfter.rovenueId != idBefore,
            "rovenueId should differ after logOut (got same: ${userAfter.rovenueId})"
        )
        assertNull(userAfter.appUserId, "appUserId should be null after logOut")
    }
}
