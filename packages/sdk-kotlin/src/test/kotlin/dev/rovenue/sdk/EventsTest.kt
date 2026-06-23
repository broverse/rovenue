package dev.rovenue.sdk

import dev.rovenue.sdk.generated.ErrorKind
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class EventsTest {

    private val json = Json {
        encodeDefaults = false
        explicitNulls = false
    }

    // ------------------------------------------------------------------
    // Case 0: Façade track() forwards envelopeJson to core
    // ------------------------------------------------------------------
    // Verifies the façade wrapper dispatches to core.track(): the Rust
    // core attempts an HTTP POST to the (unreachable) base URL, which
    // proves the call was forwarded rather than silently dropped.
    // A NetworkUnavailable exception is the expected outcome against an
    // unreachable host — a no-op stub would not produce any exception.
    @Test
    fun `track forwards envelope to core`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://unreachable.invalid")
        val ex = assertFailsWith<RovenueException> {
            Rovenue.shared.track("""{"eventType":"purchase","occurredAt":"2026-06-20T00:00:00Z"}""")
        }
        assertEquals(ErrorKind.NETWORK_UNAVAILABLE, ex.kind)
    }

    // ------------------------------------------------------------------
    // Case 3: Façade claimFunnelToken() forwards token to core
    // ------------------------------------------------------------------
    // Verifies the façade dispatches to core.claimFunnelToken(): the Rust
    // core attempts an HTTP request to the (unreachable) base URL, which
    // proves the call was forwarded rather than silently dropped.
    // A NetworkUnavailable exception is the expected outcome against an
    // unreachable host — a no-op stub would not produce any exception.
    @Test
    fun `claimFunnelToken forwards token to core`() = runTest {
        Rovenue.configure(apiKey = "pk_test_xyz", baseUrl = "https://unreachable.invalid")
        val ex = assertFailsWith<RovenueException> {
            Rovenue.shared.claimFunnelToken("some_token_value")
        }
        assertEquals(ErrorKind.NETWORK_UNAVAILABLE, ex.kind)
    }

    // ------------------------------------------------------------------
    // Case 1: Full round-trip
    // ------------------------------------------------------------------
    // Encodes an EventEnvelope with a fully-populated IdentityContext,
    // then decodes it back and asserts field fidelity.
    @Test
    fun `full round-trip preserves all fields`() {
        val ic = IdentityContext(
            email = "user@example.com",
            externalId = "ext-42",
            phone = "+15550001234",
            ip = "1.2.3.4",
            userAgent = "Mozilla/5.0",
            firstName = "Ada",
            lastName = "Lovelace",
            city = "London",
            countryCode = "GB",
        )
        val env = EventEnvelope(
            eventType = "Purchase",
            occurredAt = "2026-05-28T10:00:00Z",
            subscriberId = "sub_abc",
            productId = "prod_xyz",
            amount = "9.99",
            currency = "USD",
            eventSourceUrl = "https://example.com/buy",
            identityContext = ic,
        )

        val encoded = json.encodeToString(EventEnvelope.serializer(), env)

        // Wire keys must be present
        assertTrue(encoded.contains("\"identityContext\""), "identityContext missing from JSON")
        assertTrue(encoded.contains("\"externalId\""), "externalId missing from JSON")
        assertTrue(encoded.contains("\"userAgent\""), "userAgent missing from JSON")

        // Decode back
        val decoded = json.decodeFromString(EventEnvelope.serializer(), encoded)
        assertEquals("user@example.com", decoded.identityContext?.email)
        assertEquals("ext-42", decoded.identityContext?.externalId)
        assertEquals("Purchase", decoded.eventType)
        assertEquals("2026-05-28T10:00:00Z", decoded.occurredAt)
    }

    // ------------------------------------------------------------------
    // Case 2: IdentityContext with only email serialises compactly
    // ------------------------------------------------------------------
    // When all other fields are null, the encoded JSON must be exactly
    // {"email":"a@b.co"} — no extra null keys.
    @Test
    fun `IdentityContext with only email serializes to compact JSON`() {
        val ic = IdentityContext(email = "a@b.co")
        val encoded = json.encodeToString(IdentityContext.serializer(), ic)
        assertEquals("""{"email":"a@b.co"}""", encoded)
    }
}
