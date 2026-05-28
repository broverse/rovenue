// =============================================================
// EventEnvelope — wire format for SDK-ingested events
// =============================================================
//
// Serialises to / deserialises from the camelCase JSON shape that
// the server's /v1/events endpoint consumes.  All optional fields
// are omitted when absent so the wire payload stays minimal.

use serde::{Deserialize, Serialize};
use super::IdentityContext;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
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
}
