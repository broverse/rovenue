// PaywallMapping.kt — CorePaywall -> Paywall DTO mapping + the
// logPaywallShown envelope builder. Pure (no I/O) so it's directly
// unit-testable without a live core/network.

package dev.rovenue.sdk.internal

import dev.rovenue.sdk.EventEnvelope
import dev.rovenue.sdk.Paywall
import dev.rovenue.sdk.PaywallContext
import dev.rovenue.sdk.PresentedContext
import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.generated.CorePaywall
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

private val remoteConfigJson = Json { ignoreUnknownKeys = true }

/** Wire serializer for [EventEnvelope] — omits nulls/defaults so the JSON
 *  matches the compact shape the server's `.strict()` schema expects
 *  (mirrors the Kotlin-side `EventsTest.kt` doc example). */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
internal val eventEnvelopeJson = Json { encodeDefaults = false; explicitNulls = false }

/** Serialize an [EventEnvelope] to the compact wire JSON `track()` expects. */
internal fun encodeEventEnvelope(envelope: EventEnvelope): String =
    eventEnvelopeJson.encodeToString(EventEnvelope.serializer(), envelope)

/**
 * Decode a raw JSON object string into `Map<String, Any?>`. Returns `null`
 * for a `null` input, malformed JSON, or JSON whose top level isn't an
 * object — a paywall with a broken remote-config payload must still
 * resolve, just without the config (never throws).
 */
internal fun decodeRemoteConfig(json: String?): Map<String, Any?>? {
    if (json == null) return null
    val element = try {
        remoteConfigJson.parseToJsonElement(json)
    } catch (_: Exception) {
        return null
    }
    if (element !is JsonObject) return null
    return element.mapValues { (_, v) -> v.toKotlin() }
}

private fun JsonElement.toKotlin(): Any? = when (this) {
    is JsonNull -> null
    is JsonObject -> mapValues { (_, v) -> v.toKotlin() }
    is JsonArray -> map { it.toKotlin() }
    is JsonPrimitive -> when {
        !isString && booleanOrNull != null -> booleanOrNull
        !isString && longOrNull != null -> longOrNull
        !isString && doubleOrNull != null -> doubleOrNull
        else -> content
    }
}

internal fun mapPresentedContext(
    core: dev.rovenue.sdk.generated.CorePresentedContext,
): PresentedContext = PresentedContext(
    placementId = core.placementId,
    paywallId = core.paywallId,
    variantId = core.variantId,
    experimentKey = core.experimentKey,
    revision = core.revision,
)

/**
 * Maps the core FFI record to the public [Paywall] DTO. [offering] is
 * passed in already hydrated with live Play Billing pricing — this
 * function does no I/O.
 */
internal fun mapPaywall(core: CorePaywall, offering: Offering?): Paywall = Paywall(
    placementIdentifier = core.placementIdentifier,
    placementRevision = core.placementRevision,
    paywallIdentifier = core.paywallIdentifier,
    paywallName = core.paywallName,
    configFormatVersion = core.configFormatVersion,
    remoteConfig = decodeRemoteConfig(core.remoteConfigJson),
    remoteConfigLocale = core.remoteConfigLocale,
    offering = offering,
    presentedContext = core.presentedContext?.let(::mapPresentedContext),
    builderConfigJson = core.builderConfigJson,
)

/**
 * The [dev.rovenue.sdk.Rovenue.getPaywall] result-building step, pulled out
 * as a pure function so the "resolved to nothing -> null, never throws"
 * passthrough is unit-testable without a live core/network: `ffi == null`
 * (placement retired, `target: none`, unknown identifier — NOT an error)
 * must produce `null`, not a mapped [Paywall] with garbage fields.
 */
internal fun buildPaywallResult(ffi: CorePaywall?, offering: Offering?): Paywall? =
    ffi?.let { mapPaywall(it, offering) }

/**
 * Builds the `paywall_view` event envelope [dev.rovenue.sdk.Rovenue.logPaywallShown]
 * enqueues. Returns `null` when the paywall carries no `presentedContext` —
 * this is analytics, not a critical path, so a paywall resolved from a
 * payload that (for whatever reason) has no attribution snapshot is
 * silently skipped rather than sending a `paywallContext`-less envelope
 * the server's `.strict()` schema would reject anyway.
 */
internal fun paywallViewEnvelope(paywall: Paywall, eventId: String, occurredAt: String): EventEnvelope? {
    val ctx = paywall.presentedContext ?: return null
    return EventEnvelope(
        version = 1,
        eventId = eventId,
        eventType = "paywall_view",
        occurredAt = occurredAt,
        paywallContext = PaywallContext(
            paywallId = ctx.paywallId,
            placementId = ctx.placementId,
            placementRevision = ctx.revision,
            variantId = ctx.variantId,
            experimentKey = ctx.experimentKey,
        ),
    )
}
