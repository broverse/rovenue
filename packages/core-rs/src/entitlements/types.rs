use serde::Deserialize;

/// FFI-visible entitlement projection.
#[derive(Debug, Clone, PartialEq)]
pub struct Entitlement {
    pub id: String,
    pub is_active: bool,
    pub product_identifier: String,
    pub store: String,
    pub expires_iso: Option<String>,
}

/// Wire model: server returns `{ data: { entitlements: { "<key>": EntitlementWire } } }`.
#[derive(Debug, Deserialize)]
pub struct EntitlementWire {
    #[serde(rename = "isActive")]
    pub is_active: bool,
    #[serde(rename = "expiresDate")]
    pub expires_date: Option<String>,
    pub store: String,
    #[serde(rename = "productIdentifier")]
    pub product_identifier: String,
}

#[derive(Debug, Deserialize)]
pub struct EntitlementsResponse {
    pub entitlements: std::collections::HashMap<String, EntitlementWire>,
}
