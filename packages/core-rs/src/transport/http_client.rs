use std::time::Duration;

use reqwest::blocking::Client;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{RovenueError, RovenueResult};

use super::retry::{backoff, classify, RetryDecision};
use super::types::HttpResponse;

pub use super::types::HttpPostRequest;
pub use super::types::HttpRequest;

pub struct HttpClient {
    base_url: String,
    api_key: String,
    inner: Client,
    max_attempts: u32,
    min_backoff: Duration,
    request_timeout: Duration,
    /// Runtime platform (ios/android/web), sent as `X-Rovenue-Platform` on
    /// every request when set. `None` omits the header.
    platform: Option<String>,
    /// Remote Config environment (prod/staging/development), sent as
    /// `X-Rovenue-Env` on every request when set. `None` omits the header so
    /// the backend falls back to `prod`.
    environment: Option<String>,
}

impl HttpClient {
    pub fn new(base_url: String, api_key: String) -> Self {
        Self {
            base_url,
            api_key,
            inner: Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("reqwest blocking client"),
            max_attempts: 3,
            min_backoff: Duration::from_millis(50),
            request_timeout: Duration::from_secs(10),
            platform: None,
            environment: None,
        }
    }

    /// Builder-style setter for the runtime platform header. A blank/whitespace
    /// value is treated as absent so the header is never sent empty.
    pub fn with_platform(mut self, platform: Option<String>) -> Self {
        self.platform = platform
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());
        self
    }

    /// Builder-style setter for the Remote Config environment header. A
    /// blank/whitespace value is treated as absent so the header is never sent
    /// empty (the backend then defaults to `prod`).
    pub fn with_environment(mut self, environment: Option<String>) -> Self {
        self.environment = environment
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty());
        self
    }

    pub fn with_max_attempts(mut self, n: u32) -> Self {
        self.max_attempts = n.max(1);
        self
    }

    pub fn with_min_backoff(mut self, d: Duration) -> Self {
        self.min_backoff = d;
        self
    }

    pub fn with_request_timeout(mut self, d: Duration) -> Self {
        self.request_timeout = d;
        self.inner = Client::builder()
            .timeout(d)
            .build()
            .expect("reqwest blocking client");
        self
    }

    pub fn get_json<T: DeserializeOwned>(
        &self,
        req: HttpRequest<'_>,
    ) -> RovenueResult<HttpResponse<T>> {
        let url = format!("{}{}", self.base_url, req.path);
        let mut rng = rand::thread_rng();
        let mut last_err = RovenueError::NetworkUnavailable;

        for attempt in 0..self.max_attempts {
            let mut builder = self
                .inner
                .get(&url)
                .header("Authorization", format!("Bearer {}", self.api_key));
            if let Some(scope) = req.user_scope {
                builder = builder.header("X-Rovenue-App-User-Id", scope);
            }
            if let Some(subscriber) = req.subscriber_id {
                builder = builder.header("X-Rovenue-User-Id", subscriber);
            }
            if let Some(platform) = &self.platform {
                builder = builder.header("X-Rovenue-Platform", platform);
            }
            if let Some(environment) = &self.environment {
                builder = builder.header("X-Rovenue-Env", environment);
            }
            if let Some(etag) = req.etag {
                builder = builder.header("If-None-Match", etag);
            }

            match builder.send() {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let retry_after = resp
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .map(Duration::from_secs);
                    let etag_out = resp
                        .headers()
                        .get("ETag")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned);

                    match classify(Some(status), retry_after) {
                        RetryDecision::Success => {
                            let body = if status == 304 || status == 204 {
                                None
                            } else {
                                Some(resp.json::<T>().map_err(|_| RovenueError::Internal)?)
                            };
                            return Ok(HttpResponse {
                                status,
                                etag: etag_out,
                                body,
                            });
                        }
                        RetryDecision::Retryable => {
                            last_err = if (500..600).contains(&status) {
                                RovenueError::ServerError
                            } else {
                                RovenueError::NetworkUnavailable
                            };
                            if attempt + 1 < self.max_attempts {
                                let d = backoff(attempt, &mut rng).max(self.min_backoff);
                                std::thread::sleep(d);
                            }
                        }
                        RetryDecision::RetryAfter(d) => {
                            use super::retry::RETRY_AFTER_MAX;
                            if d > RETRY_AFTER_MAX {
                                return Err(RovenueError::RateLimited);
                            }
                            last_err = RovenueError::RateLimited;
                            if attempt + 1 < self.max_attempts {
                                std::thread::sleep(d.max(self.min_backoff));
                            }
                        }
                        RetryDecision::Fatal => {
                            return Err(if status == 401 {
                                RovenueError::InvalidApiKey
                            } else {
                                RovenueError::ServerError
                            });
                        }
                    }
                }
                Err(e) if e.is_timeout() => {
                    last_err = RovenueError::Timeout;
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
                Err(_) => {
                    last_err = RovenueError::NetworkUnavailable;
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
            }
        }

        Err(last_err)
    }

    /// POST a batch of session telemetry events to `/v1/sdk/sessions`.
    /// Best-effort: returns Ok(()) for any 2xx, and discards the response body.
    pub fn post_sessions(
        &self,
        subscriber_id: &str,
        events: &[serde_json::Value],
    ) -> RovenueResult<()> {
        let body = serde_json::json!({
            "subscriberId": subscriber_id,
            "events": events,
        });
        let _resp = self.post_json::<serde_json::Value, serde_json::Value>(
            super::types::HttpPostRequest::new("/v1/sdk/sessions").user_scope(subscriber_id),
            &body,
        )?;
        Ok(())
    }

    /// POST a batch of attribute mutations to /v1/me/attributes. The
    /// subscriber is resolved server-side from the user-scope header.
    /// `attributes` maps key -> Some(value) to set, or None to delete.
    pub fn post_attributes(
        &self,
        subscriber_id: &str,
        attributes: &serde_json::Map<String, serde_json::Value>,
    ) -> RovenueResult<()> {
        let body = serde_json::json!({ "attributes": attributes });
        let _resp = self.post_json::<serde_json::Value, serde_json::Value>(
            super::types::HttpPostRequest::new("/v1/me/attributes").user_scope(subscriber_id),
            &body,
        )?;
        Ok(())
    }

    pub fn post_json<B: Serialize, T: DeserializeOwned>(
        &self,
        req: super::types::HttpPostRequest<'_>,
        body: &B,
    ) -> RovenueResult<HttpResponse<T>> {
        use super::retry::{backoff, classify, RetryDecision, RETRY_AFTER_MAX};

        let url = format!("{}{}", self.base_url, req.path);
        let mut rng = rand::thread_rng();
        let mut last_err = RovenueError::NetworkUnavailable;

        let payload = serde_json::to_vec(body).map_err(|_| RovenueError::Internal)?;

        for attempt in 0..self.max_attempts {
            let mut builder = self
                .inner
                .post(&url)
                .header("Authorization", format!("Bearer {}", self.api_key))
                .header("Content-Type", "application/json");
            if let Some(scope) = req.user_scope {
                builder = builder.header("X-Rovenue-App-User-Id", scope);
            }
            if let Some(platform) = &self.platform {
                builder = builder.header("X-Rovenue-Platform", platform);
            }
            if let Some(environment) = &self.environment {
                builder = builder.header("X-Rovenue-Env", environment);
            }
            if let Some(key) = req.idempotency_key {
                builder = builder.header("Idempotency-Key", key);
            }
            let req_built = builder.body(payload.clone());

            match req_built.send() {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let retry_after = resp
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .map(std::time::Duration::from_secs);

                    // 422 = idempotency-key conflict (different body for same key).
                    if status == 422 {
                        return Err(RovenueError::Internal);
                    }
                    // 402 = InsufficientCredits.
                    if status == 402 {
                        return Err(RovenueError::InsufficientCredits);
                    }

                    match classify(Some(status), retry_after) {
                        RetryDecision::Success => {
                            // 202 Accepted (and 204) carry no body — the events
                            // endpoint returns an empty 202. Parsing would fail.
                            let body = if status == 204 || status == 202 {
                                None
                            } else {
                                Some(resp.json::<T>().map_err(|_| RovenueError::Internal)?)
                            };
                            return Ok(HttpResponse {
                                status,
                                etag: None,
                                body,
                            });
                        }
                        RetryDecision::Retryable => {
                            last_err = if (500..600).contains(&status) {
                                RovenueError::ServerError
                            } else {
                                RovenueError::NetworkUnavailable
                            };
                            if attempt + 1 < self.max_attempts {
                                let d = backoff(attempt, &mut rng).max(self.min_backoff);
                                std::thread::sleep(d);
                            }
                        }
                        RetryDecision::RetryAfter(d) => {
                            if d > RETRY_AFTER_MAX {
                                return Err(RovenueError::RateLimited);
                            }
                            last_err = RovenueError::RateLimited;
                            if attempt + 1 < self.max_attempts {
                                std::thread::sleep(d.max(self.min_backoff));
                            }
                        }
                        RetryDecision::Fatal => {
                            return Err(if status == 401 {
                                RovenueError::InvalidApiKey
                            } else {
                                RovenueError::ServerError
                            });
                        }
                    }
                }
                Err(e) if e.is_timeout() => {
                    last_err = RovenueError::Timeout;
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
                Err(_) => {
                    last_err = RovenueError::NetworkUnavailable;
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
            }
        }
        Err(last_err)
    }
}

#[cfg(test)]
mod post_json_tests {
    use super::*;
    use super::super::types::HttpPostRequest;

    #[test]
    fn post_json_accepts_empty_202_body() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .with_status(202)
            .create();

        let client = HttpClient::new(server.url(), "pk_test".into()).with_max_attempts(1);
        let body = serde_json::json!({ "eventType": "x", "occurredAt": "2026-06-20T00:00:00Z" });
        let resp = client
            .post_json::<serde_json::Value, serde_json::Value>(
                HttpPostRequest::new("/v1/events"),
                &body,
            )
            .expect("202 must be Ok");

        assert_eq!(resp.status, 202);
        assert!(resp.body.is_none());
        m.assert();
    }
}
