use serde::{Deserialize, Serialize};

use crate::offerings::types::OfferingWire;

// =============================================================
// Wire types — `GET /v1/placements/{identifier}?locale=` response.
// Envelope (see apps/api/src/routes/v1/placements.ts):
//   { data: { placement: {identifier, revision}|null,
//             paywall: PaywallWire|null,
//             experiment: {id, key, variants:[{variantId, weight, paywall}]}|null } }
//
// All wire types derive both Deserialize (decode the live HTTP response) and
// Serialize (round-trip the raw response through the local cache: encoded on
// a successful fetch, decoded back when served offline) — mirrors
// offerings/types.rs.
// =============================================================

#[derive(Debug, Deserialize, Serialize)]
pub struct PlacementInfoWire {
    pub identifier: String,
    pub revision: i64,
}

/// `remoteConfig: { locale, data }` on a hydrated paywall — `data` is
/// arbitrary JSON, kept as `Value` and re-serialized verbatim into
/// `CorePaywall.remote_config_json` (façades decode it themselves).
#[derive(Debug, Deserialize, Serialize)]
pub struct RemoteConfigWire {
    pub locale: String,
    pub data: serde_json::Value,
}

/// Matches the `hydratePaywall(...)` shape in
/// apps/api/src/routes/v1/placements.ts — the same shape whether reached via
/// the direct `paywall` field or via an experiment variant's `paywall`.
#[derive(Debug, Deserialize, Serialize)]
pub struct PaywallWire {
    pub id: String,
    pub identifier: String,
    pub name: String,
    #[serde(rename = "configFormatVersion")]
    pub config_format_version: i64,
    #[serde(rename = "remoteConfig")]
    pub remote_config: Option<RemoteConfigWire>,
    /// Phase-B builder component tree — arbitrary JSON, present only when
    /// the paywall has one. `default` so responses/cache entries predating
    /// the field keep decoding.
    #[serde(rename = "builderConfig", default)]
    pub builder_config: Option<serde_json::Value>,
    pub offering: Option<OfferingWire>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ExperimentVariantWire {
    #[serde(rename = "variantId")]
    pub variant_id: String,
    pub weight: f64,
    pub paywall: PaywallWire,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ExperimentWire {
    pub id: String,
    pub key: String,
    pub variants: Vec<ExperimentVariantWire>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct PlacementsResponse {
    #[serde(default)]
    pub placement: Option<PlacementInfoWire>,
    #[serde(default)]
    pub paywall: Option<PaywallWire>,
    #[serde(default)]
    pub experiment: Option<ExperimentWire>,
}

// =============================================================
// FFI-facing types (UDL: CorePaywall, CorePresentedContext).
// =============================================================

/// Paywall-attribution snapshot for the paywall a `get_paywall` call
/// resolved. Round-tripped opaquely (never validated) as `presentedContext`
/// on the next receipt/purchase POST — see
/// apps/api/src/lib/presented-context.ts.
#[derive(Debug, Clone, PartialEq)]
pub struct CorePresentedContext {
    pub placement_id: String,
    pub paywall_id: String,
    pub variant_id: Option<String>,
    pub experiment_key: Option<String>,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CorePaywall {
    pub placement_identifier: String,
    pub placement_revision: i64,
    pub paywall_identifier: Option<String>,
    pub paywall_name: Option<String>,
    pub config_format_version: i64,
    /// Raw JSON string of the resolved locale's `data` object — NOT modeled
    /// as a HashMap/record (known uniffi record→HashMap gotcha); façades
    /// decode it on their side.
    pub remote_config_json: Option<String>,
    pub remote_config_locale: Option<String>,
    /// Raw JSON string of the Phase-B builder component tree (same
    /// string-not-record rationale as `remote_config_json`); native
    /// renderers decode it, older façades simply ignore it.
    pub builder_config_json: Option<String>,
    pub offering: Option<crate::offerings::types::CoreOffering>,
    pub presented_context: Option<CorePresentedContext>,
}
