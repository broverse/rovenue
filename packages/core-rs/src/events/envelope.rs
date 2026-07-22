// =============================================================
// EventEnvelope — wire format for SDK-ingested events
// =============================================================
//
// Serialises to / deserialises from the camelCase JSON shape that
// the server's /v1/events endpoint consumes.  All optional fields
// are omitted when absent so the wire payload stays minimal.

use super::IdentityContext;
use serde::{Deserialize, Serialize};

/// Paywall-attribution payload for the `paywall_view` event — mirrors
/// `paywallContext` on the server's `eventEnvelopeSchema` (.strict(), see
/// apps/api/src/routes/v1/events.ts) and `CorePresentedContext` (see
/// placements/types.rs), which is the source façades build this from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaywallContext {
    pub paywall_id: String,
    pub placement_id: String,
    pub placement_revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experiment_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    /// Wire format version (EVENT_WIRE_VERSION). Populated by `track()`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u8>,

    /// Stable, client-generated id reused across retries so downstream
    /// fan-out can dedupe. Populated by `track()` when the caller omits it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,

    pub event_type: String,

    /// ISO-8601 UTC timestamp, e.g. "2026-05-28T10:00:00Z"
    pub occurred_at: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscriber_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,

    /// Decimal string, e.g. "9.99"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<String>,

    /// ISO-4217 three-letter code, e.g. "USD"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_source_url: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_context: Option<IdentityContext>,

    /// `paywall_view` attribution payload. Absent for every other event type.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paywall_context: Option<PaywallContext>,
}
