use serde::{Deserialize, Serialize};

/// Body of POST /v1/receipts/{apple|google}.
#[derive(Debug, Serialize)]
pub struct ReceiptBody<'a> {
    pub receipt: &'a str,
    #[serde(rename = "appUserId")]
    pub app_user_id: &'a str,
    #[serde(rename = "productId")]
    pub product_id: &'a str,
}

/// Wire model for the receipt response body (inside the `data` envelope).
#[derive(Debug, Deserialize)]
pub struct ReceiptResponse {
    pub subscriber: ReceiptSubscriber,
    pub credits: ReceiptCredits,
}

#[derive(Debug, Deserialize)]
pub struct ReceiptSubscriber {
    pub id: String,
    #[serde(rename = "appUserId")]
    pub app_user_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ReceiptCredits {
    pub balance: i64,
}

/// FFI-visible projection. The server's `access` field is dropped here — callers
/// should call `entitlements_all()` to read the cache; we refresh entitlements +
/// emit the observer instead of duplicating the access map onto the receipt struct.
#[derive(Debug, Clone, PartialEq)]
pub struct ReceiptResult {
    pub subscriber_id: String,
    pub app_user_id: String,
    pub credit_balance: i64,
}
