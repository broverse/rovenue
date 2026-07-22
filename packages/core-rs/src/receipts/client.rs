use std::sync::Arc;

use crate::error::{RovenueError, RovenueResult};
use crate::placements::CorePresentedContext;
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;

use super::types::{PresentedContextWire, ReceiptBody, ReceiptPostOutcome, ReceiptResponse};

pub struct ReceiptClient {
    http: Arc<HttpClient>,
}

impl ReceiptClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn post_apple(
        &self,
        receipt: &str,
        app_user_id: &str,
        product_id: &str,
        idempotency_key: &str,
        app_account_token: Option<&str>,
        presented_context: Option<&CorePresentedContext>,
    ) -> RovenueResult<ReceiptPostOutcome> {
        self.post(
            "/v1/receipts/apple",
            receipt,
            app_user_id,
            product_id,
            idempotency_key,
            app_account_token,
            None,
            None,
            presented_context,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn post_google(
        &self,
        receipt: &str,
        app_user_id: &str,
        product_id: &str,
        idempotency_key: &str,
        obfuscated_account_id: Option<&str>,
        obfuscated_profile_id: Option<&str>,
        presented_context: Option<&CorePresentedContext>,
    ) -> RovenueResult<ReceiptPostOutcome> {
        self.post(
            "/v1/receipts/google",
            receipt,
            app_user_id,
            product_id,
            idempotency_key,
            None,
            obfuscated_account_id,
            obfuscated_profile_id,
            presented_context,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn post(
        &self,
        path: &str,
        receipt: &str,
        app_user_id: &str,
        product_id: &str,
        idempotency_key: &str,
        app_account_token: Option<&str>,
        obfuscated_account_id: Option<&str>,
        obfuscated_profile_id: Option<&str>,
        presented_context: Option<&CorePresentedContext>,
    ) -> RovenueResult<ReceiptPostOutcome> {
        let presented_context_wire = presented_context.map(|c| PresentedContextWire {
            placement_id: &c.placement_id,
            paywall_id: &c.paywall_id,
            variant_id: c.variant_id.as_deref(),
            experiment_key: c.experiment_key.as_deref(),
        });
        let body = ReceiptBody {
            receipt,
            app_user_id,
            product_id,
            app_account_token,
            obfuscated_account_id,
            obfuscated_profile_id,
            presented_context: presented_context_wire,
        };
        let resp = self
            .http
            .post_json::<ReceiptBody<'_>, ApiEnvelope<ReceiptResponse>>(
                HttpPostRequest::new(path)
                    .user_scope(app_user_id)
                    .idempotency_key(idempotency_key),
                &body,
            )?;
        let data = resp.body.ok_or(RovenueError::Internal())?.data;
        Ok(ReceiptPostOutcome {
            subscriber_id: data.subscriber.id,
            app_user_id: data.subscriber.app_user_id,
            virtual_currencies: data.virtual_currency_balances,
            access: data.access,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn post_apple_parses_access_map() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/receipts/apple")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"subscriber":{"id":"sub_1","appUserId":"u1"},
                    "virtualCurrencyBalances":{"gems":42},
                    "access":{"pro":{"isActive":true,"expiresDate":null,
                              "store":"APP_STORE","productIdentifier":"pro_monthly"}}}}"#,
            )
            .create();

        let http = Arc::new(
            HttpClient::new(server.url(), "pk_test".into())
                .with_max_attempts(1)
                .with_request_timeout(Duration::from_millis(500)),
        );
        let client = ReceiptClient::new(http);
        let outcome = client
            .post_apple("rcpt", "u1", "pro_monthly", "idem_rcpt_x", None, None)
            .expect("post ok");
        assert_eq!(outcome.subscriber_id, "sub_1");
        let access = outcome.access.expect("access present");
        assert!(access.get("pro").unwrap().is_active);
    }
}
