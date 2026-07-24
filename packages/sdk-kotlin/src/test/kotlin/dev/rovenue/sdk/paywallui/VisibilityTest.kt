package dev.rovenue.sdk.paywallui

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Mirrors packages/shared/src/paywall/visibility.test.ts and
 * packages/sdk-rn/src/paywall-ui/__tests__/visibility.test.ts verbatim
 * (including every FAILS OPEN case) — the Kotlin evaluator must agree
 * with the shared implementation and the RN/Swift siblings exactly. See
 * BuilderConfigModelTest.kt for the cross-platform render-fixtures.json
 * `visibility` vector conformance proof.
 */
class VisibilityTest {

    // ---- compareVersions ------------------------------------------------

    @Test
    fun `compares component-wise, not lexically`() {
        assertTrue(compareVersions("1.10.0", "1.9.0")!! > 0)
        assertTrue(compareVersions("1.9.0", "1.10.0")!! < 0)
    }

    @Test
    fun `treats missing components as zero`() {
        assertEquals(0, compareVersions("1.2", "1.2.0"))
        assertEquals(0, compareVersions("2", "2.0.0"))
    }

    @Test
    fun `looks at a longer version's extra components`() {
        // Every other differing-length case here pads with zeros, so a
        // Math.min-style implementation would pass them all. This one
        // would not.
        assertTrue(compareVersions("1.2.5", "1.2")!! > 0)
        assertTrue(compareVersions("1.2", "1.2.5")!! < 0)
    }

    @Test
    fun `stays exact past the safe-integer range`() {
        assertTrue(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")!! > 0)
    }

    @Test
    fun `refuses to guess at a non-numeric component`() {
        assertNull(compareVersions("1.0.0-beta", "1.0.0"))
        assertNull(compareVersions("2024.spring", "2024.1"))
    }

    // ---- isNodeVisible ----------------------------------------------------

    private val ios = "ios"
    private val version2 = "2.0.0"

    @Test
    fun `shows a node with no visibility rules at all`() {
        assertTrue(isNodeVisible(null, ios, version2))
        assertTrue(isNodeVisible(Visibility(), ios, version2))
    }

    @Test
    fun `honours a platform list`() {
        assertTrue(isNodeVisible(Visibility(platform = listOf("ios")), ios, version2))
        assertFalse(isNodeVisible(Visibility(platform = listOf("android", "web")), ios, version2))
    }

    @Test
    fun `FAILS OPEN on an empty platform list -- it means 'no constraint', not 'nowhere'`() {
        assertTrue(isNodeVisible(Visibility(platform = emptyList()), ios, version2))
    }

    @Test
    fun `FAILS OPEN when the renderer does not know its platform`() {
        assertTrue(isNodeVisible(Visibility(platform = listOf("android")), platform = null, appVersion = version2))
    }

    @Test
    fun `honours both version bounds inclusively`() {
        assertTrue(isNodeVisible(Visibility(minAppVersion = "2.0.0"), ios, version2))
        assertFalse(isNodeVisible(Visibility(minAppVersion = "2.0.1"), ios, version2))
        assertTrue(isNodeVisible(Visibility(maxAppVersion = "2.0.0"), ios, version2))
        assertFalse(isNodeVisible(Visibility(maxAppVersion = "1.9.9"), ios, version2))
        assertTrue(isNodeVisible(Visibility(minAppVersion = "1.0.0", maxAppVersion = "3.0.0"), ios, version2))
    }

    @Test
    fun `FAILS OPEN when the app version is unknown`() {
        assertTrue(isNodeVisible(Visibility(minAppVersion = "99.0.0"), platform = ios, appVersion = null))
        assertTrue(isNodeVisible(Visibility(maxAppVersion = "0.0.1"), platform = ios, appVersion = null))
    }

    @Test
    fun `FAILS OPEN when a version cannot be compared`() {
        assertTrue(isNodeVisible(Visibility(minAppVersion = "99.0.0"), platform = ios, appVersion = "1.0.0-beta"))
    }

    @Test
    fun `hides as soon as any applicable rule says hide`() {
        assertFalse(isNodeVisible(Visibility(platform = listOf("ios"), minAppVersion = "3.0.0"), ios, version2))
        assertFalse(isNodeVisible(Visibility(platform = listOf("android"), minAppVersion = "1.0.0"), ios, version2))
    }
}
