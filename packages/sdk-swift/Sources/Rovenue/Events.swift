// =============================================================
// Events.swift — SDK event wire types (M7.3)
// =============================================================
//
// Swift façade mirroring the Rust EventEnvelope / IdentityContext
// structs (packages/core-rs/src/events/) and the RN TS counterparts
// in packages/sdk-rn/src/events.ts.
//
// Codable conformance uses Swift's default behaviour:
//   • nil optionals are omitted from JSON output (no custom encoder needed)
//   • camelCase property names match the wire format directly
//
// Usage:
//   let env = EventEnvelope(
//       eventType: "Purchase",
//       occurredAt: "2026-05-28T10:00:00Z",
//       identityContext: IdentityContext(email: "user@example.com")
//   )
//   let json = try JSONEncoder().encode(env)

import Foundation

// Wire-format version sentinel — bump alongside the Rust constant.
public let RovenueEventWireVersion: UInt8 = 1

// -------------------------------------------------------------
// IdentityContext
// -------------------------------------------------------------

/// Caller-supplied identity signals forwarded to conversion APIs
/// (Meta CAPI, TikTok Events, etc.).  Every field is optional so
/// callers can supply exactly the data they have.
public struct IdentityContext: Codable, Equatable {
    public var email: String?
    public var externalId: String?
    public var phone: String?
    public var ip: String?
    public var userAgent: String?
    public var firstName: String?
    public var lastName: String?
    public var city: String?
    public var countryCode: String?

    public init(
        email: String? = nil,
        externalId: String? = nil,
        phone: String? = nil,
        ip: String? = nil,
        userAgent: String? = nil,
        firstName: String? = nil,
        lastName: String? = nil,
        city: String? = nil,
        countryCode: String? = nil
    ) {
        self.email = email
        self.externalId = externalId
        self.phone = phone
        self.ip = ip
        self.userAgent = userAgent
        self.firstName = firstName
        self.lastName = lastName
        self.city = city
        self.countryCode = countryCode
    }
}

// -------------------------------------------------------------
// PaywallContext
// -------------------------------------------------------------

/// `paywall_view` attribution payload — mirrors the core's
/// `PaywallContext` / the server's `paywallContext` envelope key
/// (apps/api/src/routes/v1/events.ts, `.strict()`).
public struct PaywallContext: Codable, Equatable {
    public var paywallId: String
    public var placementId: String
    public var placementRevision: Int64
    public var variantId: String?
    public var experimentKey: String?

    public init(
        paywallId: String,
        placementId: String,
        placementRevision: Int64,
        variantId: String? = nil,
        experimentKey: String? = nil
    ) {
        self.paywallId = paywallId
        self.placementId = placementId
        self.placementRevision = placementRevision
        self.variantId = variantId
        self.experimentKey = experimentKey
    }
}

// -------------------------------------------------------------
// EventEnvelope
// -------------------------------------------------------------

/// Top-level event payload sent to the Rovenue ingest endpoint.
public struct EventEnvelope: Codable, Equatable {
    /// Wire format version. Normally left `nil` — the native core stamps it.
    public var version: UInt8?
    /// Stable, client-generated id reused across retries so downstream
    /// fan-out can dedupe. `logPaywallShown` sets this explicitly; other
    /// callers normally leave it `nil` and let the core generate one.
    public var eventId: String?
    /// e.g. "Purchase", "TrialStarted", "CreditGranted"
    public var eventType: String
    /// ISO-8601 UTC timestamp, e.g. "2026-05-28T10:00:00Z"
    public var occurredAt: String
    public var subscriberId: String?
    public var productId: String?
    /// Decimal string, e.g. "9.99"
    public var amount: String?
    /// ISO-4217 three-letter code, e.g. "USD"
    public var currency: String?
    public var eventSourceUrl: String?
    public var identityContext: IdentityContext?
    /// `paywall_view` attribution payload. Absent for every other event type.
    public var paywallContext: PaywallContext?

    public init(
        version: UInt8? = nil,
        eventId: String? = nil,
        eventType: String,
        occurredAt: String,
        subscriberId: String? = nil,
        productId: String? = nil,
        amount: String? = nil,
        currency: String? = nil,
        eventSourceUrl: String? = nil,
        identityContext: IdentityContext? = nil,
        paywallContext: PaywallContext? = nil
    ) {
        self.version = version
        self.eventId = eventId
        self.eventType = eventType
        self.occurredAt = occurredAt
        self.subscriberId = subscriberId
        self.productId = productId
        self.amount = amount
        self.currency = currency
        self.eventSourceUrl = eventSourceUrl
        self.identityContext = identityContext
        self.paywallContext = paywallContext
    }
}
