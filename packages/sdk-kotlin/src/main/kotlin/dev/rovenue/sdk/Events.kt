// =============================================================
// Events.kt — SDK event wire types (M7.4)
// =============================================================
//
// Kotlin façade mirroring the Rust EventEnvelope / IdentityContext
// structs (packages/core-rs/src/events/) and the RN TS counterparts
// in packages/sdk-rn/src/events.ts.
//
// Serialisation uses kotlinx.serialization with:
//   encodeDefaults = false  — omits null fields from JSON output
//   explicitNulls   = false — never emits explicit JSON null values
//
// Usage:
//   val env = EventEnvelope(
//       eventType = "Purchase",
//       occurredAt = "2026-05-28T10:00:00Z",
//       identityContext = IdentityContext(email = "user@example.com")
//   )
//   val json = Json { encodeDefaults = false; explicitNulls = false }
//       .encodeToString(EventEnvelope.serializer(), env)

package dev.rovenue.sdk

import kotlinx.serialization.Serializable

// Wire-format version sentinel — bump alongside the Rust constant.
const val ROVENUE_EVENT_WIRE_VERSION: UByte = 1u

// -------------------------------------------------------------
// IdentityContext
// -------------------------------------------------------------

/**
 * Caller-supplied identity signals forwarded to conversion APIs
 * (Meta CAPI, TikTok Events, etc.).  Every field is optional so
 * callers can supply exactly the data they have.
 */
@Serializable
data class IdentityContext(
    val email: String? = null,
    val externalId: String? = null,
    val phone: String? = null,
    val ip: String? = null,
    val userAgent: String? = null,
    val firstName: String? = null,
    val lastName: String? = null,
    val city: String? = null,
    val countryCode: String? = null,
)

// -------------------------------------------------------------
// PaywallContext
// -------------------------------------------------------------

/**
 * `paywall_view` attribution payload — mirrors the core's `PaywallContext`
 * / the server's `paywallContext` envelope key
 * (apps/api/src/routes/v1/events.ts, `.strict()`).
 */
@Serializable
data class PaywallContext(
    val paywallId: String,
    val placementId: String,
    val placementRevision: Long,
    val variantId: String? = null,
    val experimentKey: String? = null,
)

// -------------------------------------------------------------
// EventEnvelope
// -------------------------------------------------------------

/**
 * Top-level event payload sent to the Rovenue ingest endpoint.
 */
@Serializable
data class EventEnvelope(
    /** Wire format version. Normally left null — the native core stamps it. */
    val version: Int? = null,
    /** Stable, client-generated id reused across retries so downstream
     *  fan-out can dedupe. [Rovenue.logPaywallShown] sets this explicitly;
     *  other callers normally leave it null and let the core generate one. */
    val eventId: String? = null,
    /** e.g. "Purchase", "TrialStarted", "CreditGranted" */
    val eventType: String,
    /** ISO-8601 UTC timestamp, e.g. "2026-05-28T10:00:00Z" */
    val occurredAt: String,
    val subscriberId: String? = null,
    val productId: String? = null,
    /** Decimal string, e.g. "9.99" */
    val amount: String? = null,
    /** ISO-4217 three-letter code, e.g. "USD" */
    val currency: String? = null,
    val eventSourceUrl: String? = null,
    val identityContext: IdentityContext? = null,
    /** `paywall_view` attribution payload. Absent for every other event type. */
    val paywallContext: PaywallContext? = null,
)
