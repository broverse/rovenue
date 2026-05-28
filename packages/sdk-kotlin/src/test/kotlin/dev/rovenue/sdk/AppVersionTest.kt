package dev.rovenue.sdk

import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Verifies that the Kotlin façade forwards the supplied appVersion through
 * configure() to the Rust core. The Android integration (PackageManager
 * read) lives in the RN bridge; the standalone JVM SDK takes appVersion as
 * an explicit parameter so callers on bare Android can pass
 * `packageManager.getPackageInfo(...).versionName` in themselves.
 */
class AppVersionTest {

    @BeforeEach
    fun setUp() {
        Rovenue.resetForTesting()
    }

    @Test
    fun `configure stores explicit appVersion`() {
        Rovenue.configure(
            apiKey = "pk_test_xyz",
            baseUrl = "https://api.rovenue.dev",
            appVersion = "4.5.6"
        )
        assertEquals("4.5.6", Rovenue.shared.resolvedAppVersionForTesting)
    }

    @Test
    fun `configure leaves appVersion null when omitted`() {
        Rovenue.configure(
            apiKey = "pk_test_xyz",
            baseUrl = "https://api.rovenue.dev"
        )
        assertNull(Rovenue.shared.resolvedAppVersionForTesting)
    }

    @Test
    fun `configure twice with different versions uses the latest`() {
        Rovenue.configure(
            apiKey = "pk_test_xyz",
            baseUrl = "https://api.rovenue.dev",
            appVersion = "1.0.0"
        )
        Rovenue.configure(
            apiKey = "pk_test_xyz",
            baseUrl = "https://api.rovenue.dev",
            appVersion = "2.0.0"
        )
        assertEquals("2.0.0", Rovenue.shared.resolvedAppVersionForTesting)
    }
}
