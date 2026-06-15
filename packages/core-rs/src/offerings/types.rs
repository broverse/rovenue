use serde::Deserialize;

#[derive(Debug, Clone, PartialEq)]
pub struct CoreOfferingProduct {
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

#[derive(Debug, Deserialize)]
pub struct StoreIdsWire {
    pub apple: Option<String>,
    pub google: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct OfferingProductWire {
    pub identifier: String,
    #[serde(rename = "type")]
    pub product_type: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "storeIds")]
    pub store_ids: StoreIdsWire,
}
#[derive(Debug, Deserialize)]
pub struct OfferingWire {
    pub identifier: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    pub products: Vec<OfferingProductWire>,
}
#[derive(Debug, Deserialize)]
pub struct OfferingsResponse {
    pub offerings: Vec<OfferingWire>,
}
