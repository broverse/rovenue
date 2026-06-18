use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq)]
pub struct CoreOfferingProduct {
    /// The package slot identifier (e.g. `$rc_monthly`), which is what the
    /// SDK surfaces as `Package.identifier` on the façade side.
    pub package_identifier: String,
    /// The product's own identifier (the internal product catalog id).
    pub identifier: String,
    pub product_type: String,
    pub display_name: String,
    pub apple_product_id: Option<String>,
    pub google_product_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct CoreOffering {
    pub identifier: String,
    pub is_default: bool,
    pub packages: Vec<CoreOfferingProduct>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct CoreOfferings {
    pub current: Option<String>,
    pub offerings: Vec<CoreOffering>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct StoreIdsWire {
    pub apple: Option<String>,
    pub google: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct OfferingProductWire {
    /// The package slot identifier (e.g. `$rc_monthly`).
    #[serde(rename = "packageIdentifier")]
    pub package_identifier: String,
    /// The product's own identifier.
    pub identifier: String,
    #[serde(rename = "type")]
    pub product_type: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "storeIds")]
    pub store_ids: StoreIdsWire,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct OfferingWire {
    pub identifier: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    /// The server now returns `packages` (was `products` in the v0 format).
    pub packages: Vec<OfferingProductWire>,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct OfferingsResponse {
    pub offerings: Vec<OfferingWire>,
}
