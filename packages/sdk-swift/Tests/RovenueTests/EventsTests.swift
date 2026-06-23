import XCTest
@testable import Rovenue

final class EventsTests: XCTestCase {

    // ------------------------------------------------------------------
    // Case 0: Façade track() forwards envelopeJson to core
    // ------------------------------------------------------------------
    // Mirrors the Kotlin `track forwards envelope to core` test: the Rust
    // core attempts an HTTP POST to the unreachable base URL, proving the
    // call was forwarded rather than silently dropped. A no-op stub would
    // not throw.
    func test_track_forwardsEnvelopeToCore() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://unreachable.invalid")
        do {
            try await Rovenue.shared.track(
                envelopeJson: #"{"eventType":"purchase","occurredAt":"2026-06-20T00:00:00Z"}"#
            )
            XCTFail("expected track to throw against an unreachable host")
        } catch let error as RovenueError {
            XCTAssertEqual(error.kind, .networkUnavailable)
        }
    }

    // ------------------------------------------------------------------
    // Case 1: Full round-trip
    // ------------------------------------------------------------------
    // Encodes an EventEnvelope with a fully-populated IdentityContext,
    // then decodes it back and asserts field fidelity.
    func test_eventEnvelope_fullRoundTrip() throws {
        let ic = IdentityContext(
            email: "user@example.com",
            externalId: "ext-42",
            phone: "+15550001234",
            ip: "1.2.3.4",
            userAgent: "Mozilla/5.0",
            firstName: "Ada",
            lastName: "Lovelace",
            city: "London",
            countryCode: "GB"
        )
        let env = EventEnvelope(
            eventType: "Purchase",
            occurredAt: "2026-05-28T10:00:00Z",
            subscriberId: "sub_abc",
            productId: "prod_xyz",
            amount: "9.99",
            currency: "USD",
            eventSourceUrl: "https://example.com/buy",
            identityContext: ic
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data = try encoder.encode(env)
        let json = String(data: data, encoding: .utf8)!

        // Wire keys must be present
        XCTAssertTrue(json.contains("\"identityContext\""), "identityContext missing from JSON")
        XCTAssertTrue(json.contains("\"externalId\""), "externalId missing from JSON")
        XCTAssertTrue(json.contains("\"userAgent\""), "userAgent missing from JSON")

        // Decode back
        let decoded = try JSONDecoder().decode(EventEnvelope.self, from: data)
        XCTAssertEqual(decoded.identityContext?.email, "user@example.com")
        XCTAssertEqual(decoded.identityContext?.externalId, "ext-42")
        XCTAssertEqual(decoded.eventType, "Purchase")
        XCTAssertEqual(decoded.occurredAt, "2026-05-28T10:00:00Z")
    }

    // ------------------------------------------------------------------
    // Case 2: IdentityContext with only email serialises compactly
    // ------------------------------------------------------------------
    // When all other fields are nil, the encoded JSON must be exactly
    // {"email":"a@b.co"} — no extra null keys.
    func test_identityContext_emailOnly_serializesCompactly() throws {
        let ic = IdentityContext(email: "a@b.co")
        let data = try JSONEncoder().encode(ic)
        let json = String(data: data, encoding: .utf8)!
        XCTAssertEqual(json, "{\"email\":\"a@b.co\"}")
    }
}
