use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::entitlements::types::{Entitlement, EntitlementWire};

/// Body of POST /v1/receipts/{apple|google}.
#[derive(Debug, Serialize)]
pub struct ReceiptBody<'a> {
    pub receipt: &'a str,
    #[serde(rename = "appUserId")]
    pub app_user_id: &'a str,
    #[serde(rename = "productId")]
    pub product_id: &'a str,
    /// Apple: sanity-check passthrough of the UUID the host app supplied to
    /// `Product.purchase(options: [.appAccountToken(uuid)])`. Backend may
    /// cross-reference vs the JWS-decoded `appAccountToken` claim.
    #[serde(rename = "appAccountToken", skip_serializing_if = "Option::is_none")]
    pub app_account_token: Option<&'a str>,
    /// Google: sanity-check passthrough of `setObfuscatedAccountId`.
    #[serde(
        rename = "obfuscatedAccountId",
        skip_serializing_if = "Option::is_none"
    )]
    pub obfuscated_account_id: Option<&'a str>,
    /// Google: sanity-check passthrough of `setObfuscatedProfileId`.
    #[serde(
        rename = "obfuscatedProfileId",
        skip_serializing_if = "Option::is_none"
    )]
    pub obfuscated_profile_id: Option<&'a str>,
}

/// Wire model for the receipt response body (inside the `data` envelope).
#[derive(Debug, Deserialize)]
pub struct ReceiptResponse {
    pub subscriber: ReceiptSubscriber,
    pub credits: ReceiptCredits,
    /// Entitlement access map. `None` when the server omits the field entirely
    /// (pre-0.7 API); `Some({})` means the subscriber genuinely has none.
    #[serde(default)]
    pub access: Option<HashMap<String, EntitlementWire>>,
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

/// Internal result of a receipt POST, carrying the raw access map so the core
/// can hydrate the cache without a follow-up GET. Not exposed across FFI.
#[derive(Debug)]
pub struct ReceiptPostOutcome {
    pub subscriber_id: String,
    pub app_user_id: String,
    pub credit_balance: i64,
    pub access: Option<HashMap<String, EntitlementWire>>,
}

/// FFI-visible result of a successful receipt post. Entitlements + balance are
/// taken from the POST response (the core hydrates the cache from it), so the
/// façade builds its public PurchaseResult without any follow-up GET.
#[derive(Debug, Clone, PartialEq)]
pub struct ReceiptResult {
    pub subscriber_id: String,
    pub app_user_id: String,
    pub credit_balance: i64,
    pub entitlements: Vec<Entitlement>,
}
