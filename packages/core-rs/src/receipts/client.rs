use std::sync::Arc;

use crate::error::{RovenueError, RovenueResult};
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;

use super::types::{ReceiptBody, ReceiptResponse, ReceiptResult};

pub struct ReceiptClient {
    http: Arc<HttpClient>,
}

impl ReceiptClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    pub fn post_apple(
        &self,
        receipt: &str,
        app_user_id: &str,
        product_id: &str,
        idempotency_key: &str,
        app_account_token: Option<&str>,
    ) -> RovenueResult<ReceiptResult> {
        self.post(
            "/v1/receipts/apple",
            receipt,
            app_user_id,
            product_id,
            idempotency_key,
            app_account_token,
            None,
            None,
        )
    }

    pub fn post_google(
        &self,
        receipt: &str,
        app_user_id: &str,
        product_id: &str,
        idempotency_key: &str,
        obfuscated_account_id: Option<&str>,
        obfuscated_profile_id: Option<&str>,
    ) -> RovenueResult<ReceiptResult> {
        self.post(
            "/v1/receipts/google",
            receipt,
            app_user_id,
            product_id,
            idempotency_key,
            None,
            obfuscated_account_id,
            obfuscated_profile_id,
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
    ) -> RovenueResult<ReceiptResult> {
        let body = ReceiptBody {
            receipt,
            app_user_id,
            product_id,
            app_account_token,
            obfuscated_account_id,
            obfuscated_profile_id,
        };
        let resp = self
            .http
            .post_json::<ReceiptBody, ApiEnvelope<ReceiptResponse>>(
                HttpPostRequest::new(path)
                    .user_scope(app_user_id)
                    .idempotency_key(idempotency_key),
                &body,
            )?;
        let data = resp.body.ok_or(RovenueError::Internal)?.data;
        Ok(ReceiptResult {
            subscriber_id: data.subscriber.id,
            app_user_id: data.subscriber.app_user_id,
            credit_balance: data.credits.balance,
        })
    }
}
