use std::sync::Arc;

use crate::error::{RovenueError, RovenueResult};
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;

use super::{ClaimInstallParams, FunnelClaimResult};

pub struct FunnelClient {
    http: Arc<HttpClient>,
}

impl FunnelClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// POST /v1/subscribers/claim-funnel-token. 200 → result; 404 → NotFound,
    /// 410 → Expired, 409 → AlreadyClaimed.
    pub fn claim_funnel_token(
        &self,
        token: &str,
        anon_id: &str,
    ) -> RovenueResult<FunnelClaimResult> {
        let body = serde_json::json!({ "token": token, "anon_id": anon_id });
        let (status, parsed) = self
            .http
            .post_json_status(HttpPostRequest::new("/v1/subscribers/claim-funnel-token"), &body)?;
        match status {
            200 => {
                let data = parsed
                    .and_then(|v| v.get("data").cloned())
                    .ok_or(RovenueError::Internal)?;
                let subscriber_id = data
                    .get("subscriber_id")
                    .and_then(|v| v.as_str())
                    .ok_or(RovenueError::Internal)?
                    .to_string();
                let funnel_answers_json = data
                    .get("funnel_answers")
                    .cloned()
                    .unwrap_or(serde_json::json!({}))
                    .to_string();
                Ok(FunnelClaimResult { subscriber_id, funnel_answers_json })
            }
            404 => Err(RovenueError::FunnelTokenNotFound),
            410 => Err(RovenueError::FunnelTokenExpired),
            409 => Err(RovenueError::FunnelTokenAlreadyClaimed),
            401 => Err(RovenueError::InvalidApiKey),
            _ => Err(RovenueError::ServerError),
        }
    }

    /// POST /v1/sdk/claim-install. 200 → recovered token; 404 → None (no match).
    pub fn claim_install(
        &self,
        params: &ClaimInstallParams,
        install_id: &str,
    ) -> RovenueResult<Option<String>> {
        let mut body = serde_json::json!({
            "platform": params.platform,
            "locale": params.locale,
            "timezone": params.timezone,
            "screen_dims": params.screen_dims,
            "install_id": install_id,
        });
        if let Some(dm) = &params.device_model {
            body["device_model"] = serde_json::json!(dm);
        }
        if let Some(ir) = &params.install_referrer {
            body["install_referrer"] = serde_json::json!(ir);
        }
        let (status, parsed) = self
            .http
            .post_json_status(HttpPostRequest::new("/v1/sdk/claim-install"), &body)?;
        match status {
            200 => {
                let token = parsed
                    .and_then(|v| v.get("data").and_then(|d| d.get("token")).and_then(|t| t.as_str()).map(str::to_string));
                match token {
                    Some(t) => Ok(Some(t)),
                    None => Err(RovenueError::Internal),
                }
            }
            404 => Ok(None),
            401 => Err(RovenueError::InvalidApiKey),
            _ => Err(RovenueError::ServerError),
        }
    }

    /// POST /v1/sdk/claim-via-email. Always 202; resolution happens later.
    pub fn claim_via_email(&self, email: &str, install_id: &str) -> RovenueResult<()> {
        let body = serde_json::json!({ "email": email, "install_id": install_id });
        let (status, _) = self
            .http
            .post_json_status(HttpPostRequest::new("/v1/sdk/claim-via-email"), &body)?;
        match status {
            202 | 200 => Ok(()),
            401 => Err(RovenueError::InvalidApiKey),
            _ => Err(RovenueError::ServerError),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(url: &str) -> FunnelClient {
        FunnelClient::new(Arc::new(HttpClient::new(url.to_string(), "pk_test".into()).with_max_attempts(1)))
    }

    #[test]
    fn claim_funnel_token_parses_200() {
        let mut server = mockito::Server::new();
        let m = server.mock("POST", "/v1/subscribers/claim-funnel-token")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"subscriber_id":"sub_1","entitlements":[],"funnel_answers":{"q1":"yes"}}}"#)
            .create();
        let r = client(&server.url()).claim_funnel_token("tok", "rov_x").expect("ok");
        assert_eq!(r.subscriber_id, "sub_1");
        assert_eq!(r.funnel_answers_json, r#"{"q1":"yes"}"#);
        m.assert();
    }

    #[test]
    fn claim_funnel_token_maps_status_errors() {
        let cases: &[(u16, fn(RovenueError) -> bool)] = &[
            (404, |e| matches!(e, RovenueError::FunnelTokenNotFound)),
            (410, |e| matches!(e, RovenueError::FunnelTokenExpired)),
            (409, |e| matches!(e, RovenueError::FunnelTokenAlreadyClaimed)),
        ];
        for (code, check_fn) in cases {
            let mut server = mockito::Server::new();
            let _m = server.mock("POST", "/v1/subscribers/claim-funnel-token").with_status((*code).into()).create();
            let err = client(&server.url()).claim_funnel_token("tok", "rov_x").unwrap_err();
            assert!(check_fn(err), "status {code}");
        }
    }

    #[test]
    fn claim_install_returns_token_or_none() {
        let mut server = mockito::Server::new();
        let m_ok = server.mock("POST", "/v1/sdk/claim-install").with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"token":"recovered_tok"}}"#).create();
        let params = ClaimInstallParams {
            platform: "android".into(), locale: "en-US".into(), timezone: "UTC".into(),
            screen_dims: "390x844".into(), device_model: None, install_referrer: Some("rovenue_funnel_token=recovered_tok".into()),
        };
        assert_eq!(client(&server.url()).claim_install(&params, "inst_1").unwrap(), Some("recovered_tok".into()));
        m_ok.assert();

        let mut server2 = mockito::Server::new();
        let _m404 = server2.mock("POST", "/v1/sdk/claim-install").with_status(404).create();
        assert_eq!(client(&server2.url()).claim_install(&params, "inst_1").unwrap(), None);
    }

    #[test]
    fn claim_install_malformed_200_returns_internal_error() {
        let mut server = mockito::Server::new();
        let _m = server.mock("POST", "/v1/sdk/claim-install").with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{}}"#).create();
        let params = ClaimInstallParams {
            platform: "ios".into(), locale: "en-US".into(), timezone: "UTC".into(),
            screen_dims: "390x844".into(), device_model: None, install_referrer: None,
        };
        let err = client(&server.url()).claim_install(&params, "inst_m").unwrap_err();
        assert!(matches!(err, RovenueError::Internal), "malformed 200 must be Internal error");
    }

    #[test]
    fn claim_via_email_accepts_202() {
        let mut server = mockito::Server::new();
        let m = server.mock("POST", "/v1/sdk/claim-via-email").with_status(202).create();
        client(&server.url()).claim_via_email("a@b.com", "inst_1").expect("202 ok");
        m.assert();
    }
}
