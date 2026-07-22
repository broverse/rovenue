import XCTest
@testable import Rovenue

final class PaywallMappingTests: XCTestCase {

    // ------------------------------------------------------------------
    // decodeRemoteConfig
    // ------------------------------------------------------------------

    func test_decodeRemoteConfig_nilInput_returnsNil() {
        XCTAssertNil(decodeRemoteConfig(nil))
    }

    func test_decodeRemoteConfig_malformedJson_returnsNilNotThrows() {
        XCTAssertNil(decodeRemoteConfig("{not valid json"))
    }

    func test_decodeRemoteConfig_nonObjectTopLevel_returnsNil() {
        // A JSON array is valid JSON but not the `[String: Any]` shape a
        // paywall's remote-config `data` object is documented to be.
        XCTAssertNil(decodeRemoteConfig("[1,2,3]"))
    }

    func test_decodeRemoteConfig_validObject_decodesFields() {
        let decoded = decodeRemoteConfig(#"{"title":"Go Pro","price_hint":9.99,"show_trial":true}"#)
        XCTAssertEqual(decoded?["title"] as? String, "Go Pro")
        XCTAssertEqual(decoded?["price_hint"] as? Double, 9.99)
        XCTAssertEqual(decoded?["show_trial"] as? Bool, true)
    }

    // ------------------------------------------------------------------
    // mapPaywall — CorePaywall -> Paywall DTO mapping
    // ------------------------------------------------------------------

    private func makeCorePresentedContext(
        variantId: String? = "var_a",
        experimentKey: String? = "exp_1"
    ) -> CorePresentedContext {
        CorePresentedContext(
            placementId: "plc_1",
            paywallId: "pw_1",
            variantId: variantId,
            experimentKey: experimentKey,
            revision: 3
        )
    }

    private func makeCorePaywall(
        remoteConfigJson: String? = #"{"title":"Go Pro"}"#,
        offering: CoreOffering? = nil,
        includePresentedContext: Bool = true,
        variantId: String? = "var_a",
        experimentKey: String? = "exp_1"
    ) -> CorePaywall {
        CorePaywall(
            placementIdentifier: "plc_1",
            placementRevision: 3,
            paywallIdentifier: "pw_1",
            paywallName: "Go Pro Paywall",
            configFormatVersion: 1,
            remoteConfigJson: remoteConfigJson,
            remoteConfigLocale: "en",
            offering: offering,
            presentedContext: includePresentedContext
                ? makeCorePresentedContext(variantId: variantId, experimentKey: experimentKey)
                : nil
        )
    }

    func test_mapPaywall_mapsAllScalarFields() {
        let core = makeCorePaywall()
        let paywall = mapPaywall(core, offering: nil)

        XCTAssertEqual(paywall.placementIdentifier, "plc_1")
        XCTAssertEqual(paywall.placementRevision, 3)
        XCTAssertEqual(paywall.paywallIdentifier, "pw_1")
        XCTAssertEqual(paywall.paywallName, "Go Pro Paywall")
        XCTAssertEqual(paywall.configFormatVersion, 1)
        XCTAssertEqual(paywall.remoteConfigLocale, "en")
        XCTAssertEqual(paywall.remoteConfig?["title"] as? String, "Go Pro")
    }

    func test_mapPaywall_mapsPresentedContext() {
        let core = makeCorePaywall()
        let paywall = mapPaywall(core, offering: nil)

        XCTAssertEqual(paywall.presentedContext?.placementId, "plc_1")
        XCTAssertEqual(paywall.presentedContext?.paywallId, "pw_1")
        XCTAssertEqual(paywall.presentedContext?.variantId, "var_a")
        XCTAssertEqual(paywall.presentedContext?.experimentKey, "exp_1")
        XCTAssertEqual(paywall.presentedContext?.revision, 3)
    }

    func test_mapPaywall_nilPresentedContext_passesThroughAsNil() {
        let core = makeCorePaywall(includePresentedContext: false)
        let paywall = mapPaywall(core, offering: nil)
        XCTAssertNil(paywall.presentedContext)
    }

    func test_mapPaywall_nilRemoteConfigJson_yieldsNilRemoteConfig() {
        let core = makeCorePaywall(remoteConfigJson: nil)
        let paywall = mapPaywall(core, offering: nil)
        XCTAssertNil(paywall.remoteConfig)
    }

    func test_mapPaywall_offeringPassedThroughVerbatim() {
        let offering = Offering(identifier: "default", isDefault: true, packages: [])
        let paywall = mapPaywall(makeCorePaywall(), offering: offering)
        XCTAssertEqual(paywall.offering?.identifier, "default")
    }

    // ------------------------------------------------------------------
    // paywallViewEnvelope — logPaywallShown's envelope builder
    // ------------------------------------------------------------------

    func test_paywallViewEnvelope_buildsExpectedShape() {
        let paywall = mapPaywall(makeCorePaywall(), offering: nil)
        let env = paywallViewEnvelope(paywall: paywall, eventId: "evt_stable_1", occurredAt: "2026-06-20T10:00:00Z")

        XCTAssertEqual(env?.version, 1)
        XCTAssertEqual(env?.eventId, "evt_stable_1")
        XCTAssertEqual(env?.eventType, "paywall_view")
        XCTAssertEqual(env?.occurredAt, "2026-06-20T10:00:00Z")
        XCTAssertEqual(env?.paywallContext?.paywallId, "pw_1")
        XCTAssertEqual(env?.paywallContext?.placementId, "plc_1")
        XCTAssertEqual(env?.paywallContext?.placementRevision, 3)
        XCTAssertEqual(env?.paywallContext?.variantId, "var_a")
        XCTAssertEqual(env?.paywallContext?.experimentKey, "exp_1")
        // No extra top-level keys — the server's eventEnvelopeSchema is `.strict()`.
        XCTAssertNil(env?.subscriberId)
        XCTAssertNil(env?.productId)
        XCTAssertNil(env?.amount)
    }

    func test_paywallViewEnvelope_eventIdIsStableAcrossRepeatedCalls() {
        // Regression guard: the eventId must be generated ONCE by the
        // caller (logPaywallShown) and passed in — not regenerated by this
        // pure function — so retries of the same logical "shown" event
        // dedupe server-side instead of fanning out into duplicates.
        let paywall = mapPaywall(makeCorePaywall(), offering: nil)
        let first = paywallViewEnvelope(paywall: paywall, eventId: "evt_fixed", occurredAt: "2026-06-20T10:00:00Z")
        let second = paywallViewEnvelope(paywall: paywall, eventId: "evt_fixed", occurredAt: "2026-06-20T10:00:01Z")
        XCTAssertEqual(first?.eventId, second?.eventId)
    }

    func test_paywallViewEnvelope_noPresentedContext_returnsNil() {
        // Best-effort/analytics-only: a paywall with no presented_context
        // (should not happen per the core's contract, but the DTO type is
        // Optional) must not crash logPaywallShown — it just sends nothing.
        let core = makeCorePaywall(includePresentedContext: false)
        let paywall = mapPaywall(core, offering: nil)
        XCTAssertNil(paywallViewEnvelope(paywall: paywall, eventId: "evt_x", occurredAt: "2026-06-20T10:00:00Z"))
    }

    func test_paywallViewEnvelope_omitsOptionalAttributionFieldsWhenAbsent() {
        // A direct (non-experiment) paywall assignment has no variantId/experimentKey.
        let core = makeCorePaywall(variantId: nil, experimentKey: nil)
        let paywall = mapPaywall(core, offering: nil)
        let env = paywallViewEnvelope(paywall: paywall, eventId: "evt_x", occurredAt: "2026-06-20T10:00:00Z")
        XCTAssertNil(env?.paywallContext?.variantId)
        XCTAssertNil(env?.paywallContext?.experimentKey)

        let data = try! JSONEncoder().encode(env)
        let json = String(data: data, encoding: .utf8)!
        XCTAssertFalse(json.contains("variantId"), "variantId must be omitted, not null, when absent")
        XCTAssertFalse(json.contains("experimentKey"), "experimentKey must be omitted, not null, when absent")
    }
}
