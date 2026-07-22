package dev.rovenue.sdk

import dev.rovenue.sdk.generated.CorePaywall
import dev.rovenue.sdk.generated.CorePresentedContext
import dev.rovenue.sdk.internal.buildPaywallResult
import dev.rovenue.sdk.internal.decodeRemoteConfig
import dev.rovenue.sdk.internal.encodeEventEnvelope
import dev.rovenue.sdk.internal.mapPaywall
import dev.rovenue.sdk.internal.paywallViewEnvelope
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PaywallMappingTest {

    // ------------------------------------------------------------------
    // decodeRemoteConfig
    // ------------------------------------------------------------------

    @Test
    fun `decodeRemoteConfig returns null for null input`() {
        assertNull(decodeRemoteConfig(null))
    }

    @Test
    fun `decodeRemoteConfig returns null for malformed json, does not throw`() {
        assertNull(decodeRemoteConfig("{not valid json"))
    }

    @Test
    fun `decodeRemoteConfig returns null for non-object top level`() {
        assertNull(decodeRemoteConfig("[1,2,3]"))
    }

    @Test
    fun `decodeRemoteConfig decodes a valid object including nested values`() {
        val decoded = decodeRemoteConfig(
            """{"title":"Go Pro","priceHint":9.99,"showTrial":true,"tags":["a","b"],"meta":{"nested":1}}""",
        )
        assertEquals("Go Pro", decoded?.get("title"))
        assertEquals(9.99, decoded?.get("priceHint"))
        assertEquals(true, decoded?.get("showTrial"))
        assertEquals(listOf("a", "b"), decoded?.get("tags"))
        @Suppress("UNCHECKED_CAST")
        assertEquals(1L, (decoded?.get("meta") as Map<String, Any?>)["nested"])
    }

    // ------------------------------------------------------------------
    // mapPaywall — CorePaywall -> Paywall DTO mapping
    // ------------------------------------------------------------------

    private fun corePresentedContext(
        variantId: String? = "var_a",
        experimentKey: String? = "exp_1",
    ) = CorePresentedContext(
        placementId = "plc_1",
        paywallId = "pw_1",
        variantId = variantId,
        experimentKey = experimentKey,
        revision = 3L,
    )

    private fun corePaywall(
        remoteConfigJson: String? = """{"title":"Go Pro"}""",
        offering: dev.rovenue.sdk.generated.CoreOffering? = null,
        presentedContext: CorePresentedContext? = corePresentedContext(),
    ) = CorePaywall(
        placementIdentifier = "plc_1",
        placementRevision = 3L,
        paywallIdentifier = "pw_1",
        paywallName = "Go Pro Paywall",
        configFormatVersion = 1L,
        remoteConfigJson = remoteConfigJson,
        remoteConfigLocale = "en",
        offering = offering,
        presentedContext = presentedContext,
    )

    @Test
    fun `mapPaywall maps all scalar fields`() {
        val paywall = mapPaywall(corePaywall(), offering = null)
        assertEquals("plc_1", paywall.placementIdentifier)
        assertEquals(3L, paywall.placementRevision)
        assertEquals("pw_1", paywall.paywallIdentifier)
        assertEquals("Go Pro Paywall", paywall.paywallName)
        assertEquals(1L, paywall.configFormatVersion)
        assertEquals("en", paywall.remoteConfigLocale)
        assertEquals("Go Pro", paywall.remoteConfig?.get("title"))
    }

    @Test
    fun `mapPaywall maps presentedContext`() {
        val paywall = mapPaywall(corePaywall(), offering = null)
        assertEquals("plc_1", paywall.presentedContext?.placementId)
        assertEquals("pw_1", paywall.presentedContext?.paywallId)
        assertEquals("var_a", paywall.presentedContext?.variantId)
        assertEquals("exp_1", paywall.presentedContext?.experimentKey)
        assertEquals(3L, paywall.presentedContext?.revision)
    }

    @Test
    fun `mapPaywall passes through nil presentedContext as null`() {
        val paywall = mapPaywall(corePaywall(presentedContext = null), offering = null)
        assertNull(paywall.presentedContext)
    }

    @Test
    fun `mapPaywall yields null remoteConfig when remoteConfigJson is null`() {
        val paywall = mapPaywall(corePaywall(remoteConfigJson = null), offering = null)
        assertNull(paywall.remoteConfig)
    }

    @Test
    fun `mapPaywall passes offering through verbatim`() {
        val offering = Offering(identifier = "default", isDefault = true, packages = emptyList())
        val paywall = mapPaywall(corePaywall(), offering = offering)
        assertEquals("default", paywall.offering?.identifier)
    }

    // ------------------------------------------------------------------
    // buildPaywallResult — getPaywall's "resolved to nothing -> null" gate
    // ------------------------------------------------------------------

    @Test
    fun `buildPaywallResult passes through null ffi as null, not an error`() {
        assertNull(buildPaywallResult(null, offering = null))
    }

    @Test
    fun `buildPaywallResult maps a non-null ffi to a Paywall`() {
        val result = buildPaywallResult(corePaywall(), offering = null)
        assertEquals("pw_1", result?.paywallIdentifier)
    }

    // ------------------------------------------------------------------
    // paywallViewEnvelope + encodeEventEnvelope — logPaywallShown's payload
    // ------------------------------------------------------------------

    @Test
    fun `paywallViewEnvelope builds the expected shape`() {
        val paywall = mapPaywall(corePaywall(), offering = null)
        val env = paywallViewEnvelope(paywall, eventId = "evt_stable_1", occurredAt = "2026-06-20T10:00:00Z")

        assertEquals(1, env?.version)
        assertEquals("evt_stable_1", env?.eventId)
        assertEquals("paywall_view", env?.eventType)
        assertEquals("2026-06-20T10:00:00Z", env?.occurredAt)
        assertEquals("pw_1", env?.paywallContext?.paywallId)
        assertEquals("plc_1", env?.paywallContext?.placementId)
        assertEquals(3L, env?.paywallContext?.placementRevision)
        assertEquals("var_a", env?.paywallContext?.variantId)
        assertEquals("exp_1", env?.paywallContext?.experimentKey)
        assertNull(env?.subscriberId)
        assertNull(env?.productId)
        assertNull(env?.amount)
    }

    @Test
    fun `paywallViewEnvelope eventId is stable across repeated calls, not regenerated`() {
        val paywall = mapPaywall(corePaywall(), offering = null)
        val first = paywallViewEnvelope(paywall, eventId = "evt_fixed", occurredAt = "2026-06-20T10:00:00Z")
        val second = paywallViewEnvelope(paywall, eventId = "evt_fixed", occurredAt = "2026-06-20T10:00:01Z")
        assertEquals(first?.eventId, second?.eventId)
    }

    @Test
    fun `paywallViewEnvelope returns null when paywall has no presentedContext`() {
        val paywall = mapPaywall(corePaywall(presentedContext = null), offering = null)
        assertNull(paywallViewEnvelope(paywall, eventId = "evt_x", occurredAt = "2026-06-20T10:00:00Z"))
    }

    @Test
    fun `logPaywallShown envelope, once encoded, omits optional attribution fields when absent and is strict-schema-safe`() {
        val paywall = mapPaywall(
            corePaywall(presentedContext = corePresentedContext(variantId = null, experimentKey = null)),
            offering = null,
        )
        val env = paywallViewEnvelope(paywall, eventId = "evt_x", occurredAt = "2026-06-20T10:00:00Z")!!
        val json = encodeEventEnvelope(env)

        assertTrue(json.contains("\"eventType\":\"paywall_view\""))
        assertTrue(json.contains("\"paywallContext\""))
        assertFalse(json.contains("variantId"), "variantId must be omitted, not null, when absent")
        assertFalse(json.contains("experimentKey"), "experimentKey must be omitted, not null, when absent")
        // No extra top-level keys the server's `.strict()` eventEnvelopeSchema would reject.
        assertFalse(json.contains("subscriberId"))
        assertFalse(json.contains("productId"))
        assertFalse(json.contains("identityContext"))
    }

    @Test
    fun `encodeEventEnvelope round-trips paywallContext with all fields present`() {
        val paywall = mapPaywall(corePaywall(), offering = null)
        val env = paywallViewEnvelope(paywall, eventId = "evt_full", occurredAt = "2026-06-20T10:00:00Z")!!
        val json = encodeEventEnvelope(env)

        assertTrue(json.contains("\"paywallId\":\"pw_1\""))
        assertTrue(json.contains("\"placementId\":\"plc_1\""))
        assertTrue(json.contains("\"placementRevision\":3"))
        assertTrue(json.contains("\"variantId\":\"var_a\""))
        assertTrue(json.contains("\"experimentKey\":\"exp_1\""))
    }
}
