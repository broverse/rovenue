use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{RovenueError, RovenueResult};
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;

#[derive(Debug, Serialize)]
struct IdentifyBody<'a> {
    #[serde(rename = "rovenueId")]
    rovenue_id: &'a str,
    #[serde(rename = "appUserId")]
    app_user_id: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct IdentifyResult {
    #[serde(rename = "subscriberId")]
    pub subscriber_id: String,
    #[serde(rename = "appUserId")]
    pub app_user_id: String,
    pub transferred: bool,
}

pub struct IdentifyClient {
    http: Arc<HttpClient>,
}

impl IdentifyClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// POST `/v1/identify` linking the anonymous `rovenue_id` device to an
    /// `app_user_id`. The device key travels in the `X-Rovenue-App-User-Id`
    /// header via `user_scope`.
    pub fn identify(&self, rovenue_id: &str, app_user_id: &str) -> RovenueResult<IdentifyResult> {
        let body = IdentifyBody {
            rovenue_id,
            app_user_id,
        };
        let resp = self
            .http
            .post_json::<IdentifyBody, ApiEnvelope<IdentifyResult>>(
                HttpPostRequest::new("/v1/identify").user_scope(rovenue_id),
                &body,
            )?;
        let data = resp.body.ok_or(RovenueError::Internal())?.data;
        Ok(data)
    }
}
