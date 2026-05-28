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
// EventEnvelope
// -------------------------------------------------------------

/// Top-level event payload sent to the Rovenue ingest endpoint.
public struct EventEnvelope: Codable, Equatable {
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

    public init(
        eventType: String,
        occurredAt: String,
        subscriberId: String? = nil,
        productId: String? = nil,
        amount: String? = nil,
        currency: String? = nil,
        eventSourceUrl: String? = nil,
        identityContext: IdentityContext? = nil
    ) {
        self.eventType = eventType
        self.occurredAt = occurredAt
        self.subscriberId = subscriberId
        self.productId = productId
        self.amount = amount
        self.currency = currency
        self.eventSourceUrl = eventSourceUrl
        self.identityContext = identityContext
    }
}
