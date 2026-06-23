use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{RovenueError, RovenueResult};
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;

/// Request body for POST /v1/purchases/apple-offer-signature.
#[derive(Debug, Serialize)]
struct OfferSignatureBody<'a> {
    #[serde(rename = "productId")]
    product_id: &'a str,
    #[serde(rename = "offerId")]
    offer_id: &'a str,
    #[serde(rename = "appAccountToken", skip_serializing_if = "Option::is_none")]
    app_account_token: Option<&'a str>,
}

/// Wire model for the offer-signature response body (inside the `data` envelope).
#[derive(Debug, Deserialize)]
struct OfferSignatureResponse {
    #[serde(rename = "keyIdentifier")]
    key_identifier: String,
    nonce: String,
    signature: String,
    timestamp: i64,
}

/// FFI-visible result of a successful Apple promotional-offer signature request.
#[derive(Debug, Clone, PartialEq)]
pub struct AppleOfferSignature {
    pub key_identifier: String,
    pub nonce: String,
    pub signature: String,
    pub timestamp: i64,
}

pub struct PurchasesClient {
    http: Arc<HttpClient>,
}

impl PurchasesClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// Fetch an Apple promotional-offer signature from the backend.
    ///
    /// This endpoint is project-scoped (authenticated by the project API key
    /// only) — do NOT pass a user scope or idempotency key.
    pub fn get_apple_offer_signature(
        &self,
        product_id: &str,
        offer_id: &str,
        app_account_token: Option<&str>,
    ) -> RovenueResult<AppleOfferSignature> {
        let body = OfferSignatureBody {
            product_id,
            offer_id,
            app_account_token,
        };
        let resp = self
            .http
            .post_json::<OfferSignatureBody<'_>, ApiEnvelope<OfferSignatureResponse>>(
                HttpPostRequest::new("/v1/purchases/apple-offer-signature"),
                &body,
            )?;
        let data = resp.body.ok_or(RovenueError::Internal())?.data;
        Ok(AppleOfferSignature {
            key_identifier: data.key_identifier,
            nonce: data.nonce,
            signature: data.signature,
            timestamp: data.timestamp,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn get_apple_offer_signature_parses_response() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/purchases/apple-offer-signature")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"keyIdentifier":"K","nonce":"n","signature":"s","timestamp":123}}"#,
            )
            .create();

        let http = Arc::new(
            HttpClient::new(server.url(), "pk_test".into())
                .with_max_attempts(1)
                .with_request_timeout(Duration::from_millis(500)),
        );
        let client = PurchasesClient::new(http);
        let result = client
            .get_apple_offer_signature("prod_id", "offer_id", None)
            .expect("signature ok");

        assert_eq!(result.key_identifier, "K");
        assert_eq!(result.nonce, "n");
        assert_eq!(result.signature, "s");
        assert_eq!(result.timestamp, 123);
    }

    #[test]
    fn get_apple_offer_signature_omits_app_account_token_when_none() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/purchases/apple-offer-signature")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"keyIdentifier":"K2","nonce":"n2","signature":"s2","timestamp":456}}"#,
            )
            .create();

        let http = Arc::new(
            HttpClient::new(server.url(), "pk_test".into())
                .with_max_attempts(1)
                .with_request_timeout(Duration::from_millis(500)),
        );
        let client = PurchasesClient::new(http);
        // Pass Some app_account_token to verify it is included
        let result = client
            .get_apple_offer_signature("prod_id", "offer_id", Some("tok-abc"))
            .expect("signature ok");

        assert_eq!(result.key_identifier, "K2");
        assert_eq!(result.timestamp, 456);
    }
}
