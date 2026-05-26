use serde::Deserialize;

/// FFI-visible entitlement projection.
#[derive(Debug, Clone, PartialEq)]
pub struct Entitlement {
    pub id: String,
    pub is_active: bool,
    pub product_id: Option<String>,
    pub expires_at_ms: Option<u64>,
}

/// Wire model the server returns.
#[derive(Debug, Deserialize)]
pub struct EntitlementWire {
    pub id: String,
    pub is_active: bool,
    pub product_id: Option<String>,
    #[serde(rename = "expires_at_ms")]
    pub expires_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct EntitlementsResponse {
    pub entitlements: Vec<EntitlementWire>,
}
