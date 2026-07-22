import Foundation

// MARK: - CorePaywall -> Paywall mapping (pure, unit-testable)

/// Decode a raw JSON object string into `[String: Any]`. `nil`-safe: a `nil`
/// input, an empty/malformed string, or JSON that doesn't decode to a top-
/// level object all return `nil` rather than throwing — a paywall with a
/// broken remote-config payload must still resolve, just without the config.
func decodeRemoteConfig(_ json: String?) -> [String: Any]? {
    guard let json, let data = json.data(using: .utf8) else { return nil }
    guard let obj = try? JSONSerialization.jsonObject(with: data) else { return nil }
    return obj as? [String: Any]
}

func mapPresentedContext(_ core: CorePresentedContext) -> PresentedContext {
    PresentedContext(
        placementId: core.placementId,
        paywallId: core.paywallId,
        variantId: core.variantId,
        experimentKey: core.experimentKey,
        revision: core.revision
    )
}

/// Maps the core FFI record to the public `Paywall` DTO. `offering` is
/// passed in already hydrated with live StoreKit pricing (see
/// `Rovenue.hydrateOffering(_:)`) — this function does no I/O.
func mapPaywall(_ core: CorePaywall, offering: Offering?) -> Paywall {
    Paywall(
        placementIdentifier: core.placementIdentifier,
        placementRevision: core.placementRevision,
        paywallIdentifier: core.paywallIdentifier,
        paywallName: core.paywallName,
        configFormatVersion: core.configFormatVersion,
        remoteConfig: decodeRemoteConfig(core.remoteConfigJson),
        remoteConfigLocale: core.remoteConfigLocale,
        offering: offering,
        presentedContext: core.presentedContext.map(mapPresentedContext)
    )
}

// MARK: - logPaywallShown envelope

/// Builds the `paywall_view` event envelope `logPaywallShown` enqueues.
/// Returns `nil` when the paywall carries no `presentedContext` — this is
/// analytics, not a critical path, so a paywall resolved from a payload
/// that (for whatever reason) has no attribution snapshot is silently
/// skipped rather than sending a `paywallContext`-less envelope the
/// server's `.strict()` schema would reject anyway.
func paywallViewEnvelope(paywall: Paywall, eventId: String, occurredAt: String) -> EventEnvelope? {
    guard let ctx = paywall.presentedContext else { return nil }
    return EventEnvelope(
        version: 1,
        eventId: eventId,
        eventType: "paywall_view",
        occurredAt: occurredAt,
        paywallContext: PaywallContext(
            paywallId: ctx.paywallId,
            placementId: ctx.placementId,
            placementRevision: ctx.revision,
            variantId: ctx.variantId,
            experimentKey: ctx.experimentKey
        )
    )
}
