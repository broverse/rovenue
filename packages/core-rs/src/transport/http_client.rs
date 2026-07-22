use std::time::Duration;

use reqwest::blocking::Client;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{RovenueError, RovenueResult};

use super::retry::{backoff, classify, RetryDecision};
use super::types::HttpResponse;

pub use super::types::HttpPostRequest;
pub use super::types::HttpRequest;

/// Map an HTTP error status + response body to a [`RovenueError`], preserving
/// the backend `{"error":{"code","message"}}` envelope when present.
pub fn error_from_status(status: u16, body: &str) -> RovenueError {
    use super::api::ApiErrorBody;
    use crate::error::ErrorKind;
    let kind = match status {
        401 => ErrorKind::InvalidApiKey,
        402 => ErrorKind::InsufficientCredits,
        403 => ErrorKind::Forbidden,
        404 => ErrorKind::NotFound,
        409 => ErrorKind::Conflict,
        422 | 400 => ErrorKind::InvalidRequest,
        429 => ErrorKind::RateLimited,
        405..=499 => ErrorKind::InvalidRequest, // other 4xx are client-side
        500..=599 => ErrorKind::ServerError,
        _ => ErrorKind::Internal,
    };
    match serde_json::from_str::<ApiErrorBody>(body) {
        Ok(parsed) => {
            RovenueError::http(kind, status, Some(parsed.error.code), parsed.error.message)
        }
        Err(_) => RovenueError::http(kind, status, None, String::new()),
    }
}

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
    /// Optional structured logger; when set, emits Debug + Error records per
    /// logical request. Authorization / api key are never included in records.
    logger: Option<std::sync::Arc<crate::logging::Logger>>,
    /// Monotonic counter for correlation ids (req-0, req-1, …). Counts per
    /// HttpClient instance; does NOT use wall-clock or random.
    corr_counter: std::sync::atomic::AtomicU64,
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
            logger: None,
            corr_counter: std::sync::atomic::AtomicU64::new(0),
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

    /// Attach a structured logger. When set, each logical request emits a
    /// `Debug` record (path, method, status, attempt, correlation_id) and an
    /// `Error` record on terminal failure.  `Authorization` and the api key
    /// are never included in any emitted record.
    pub fn with_logger(mut self, logger: std::sync::Arc<crate::logging::Logger>) -> Self {
        self.logger = Some(logger);
        self
    }

    /// Monotonically increasing correlation id for each logical request.
    /// Format: `req-{n}` where n starts at 0 and increments per call.
    fn next_correlation_id(&self) -> String {
        let n = self
            .corr_counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("req-{n}")
    }

    pub fn get_json<T: DeserializeOwned>(
        &self,
        req: HttpRequest<'_>,
    ) -> RovenueResult<HttpResponse<T>> {
        let url = format!("{}{}", self.base_url, req.path);
        let mut rng = rand::thread_rng();
        let mut last_err = RovenueError::NetworkUnavailable();
        let corr = self.next_correlation_id();

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
                    if let Some(l) = &self.logger {
                        let path = req.path.to_string();
                        let corr_c = corr.clone();
                        l.log(
                            crate::logging::LogLevel::Debug,
                            || format!("http GET {path}"),
                            || {
                                let mut f = std::collections::HashMap::new();
                                f.insert("method".to_string(), "GET".to_string());
                                f.insert("path".to_string(), path.clone());
                                f.insert("status".to_string(), status.to_string());
                                f.insert("attempt".to_string(), attempt.to_string());
                                f.insert("correlation_id".to_string(), corr_c);
                                crate::logging::redact::redact_fields(f)
                            },
                        );
                    }
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
                                Some(resp.json::<T>().map_err(|_| RovenueError::Internal())?)
                            };
                            return Ok(HttpResponse {
                                status,
                                etag: etag_out,
                                body,
                            });
                        }
                        RetryDecision::Retryable => {
                            last_err = if (500..600).contains(&status) {
                                RovenueError::ServerError()
                            } else {
                                RovenueError::NetworkUnavailable()
                            };
                            if attempt + 1 < self.max_attempts {
                                let d = backoff(attempt, &mut rng).max(self.min_backoff);
                                std::thread::sleep(d);
                            }
                        }
                        RetryDecision::RetryAfter(d) => {
                            use super::retry::RETRY_AFTER_MAX;
                            if d > RETRY_AFTER_MAX {
                                return Err(RovenueError::RateLimited());
                            }
                            last_err = RovenueError::RateLimited();
                            if attempt + 1 < self.max_attempts {
                                std::thread::sleep(d.max(self.min_backoff));
                            }
                        }
                        RetryDecision::Fatal => {
                            let body_text = resp.text().unwrap_or_default();
                            let err = error_from_status(status, &body_text);
                            if let Some(l) = &self.logger {
                                let path = req.path.to_string();
                                let corr_c = corr.clone();
                                let kind = format!("{:?}", err.kind);
                                l.log(
                                    crate::logging::LogLevel::Error,
                                    || format!("http GET {path} failed"),
                                    || {
                                        let mut f = std::collections::HashMap::new();
                                        f.insert("method".to_string(), "GET".to_string());
                                        f.insert("path".to_string(), path.clone());
                                        f.insert("status".to_string(), status.to_string());
                                        f.insert("attempt".to_string(), attempt.to_string());
                                        f.insert("correlation_id".to_string(), corr_c);
                                        f.insert("kind".to_string(), kind);
                                        crate::logging::redact::redact_fields(f)
                                    },
                                );
                            }
                            return Err(err);
                        }
                    }
                }
                Err(e) if e.is_timeout() => {
                    last_err = RovenueError::Timeout();
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
                Err(_) => {
                    last_err = RovenueError::NetworkUnavailable();
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
            }
        }

        // Terminal network/timeout failure after all attempts exhausted.
        if let Some(l) = &self.logger {
            let path = req.path.to_string();
            let corr_c = corr.clone();
            let kind = format!("{:?}", last_err.kind);
            l.log(
                crate::logging::LogLevel::Error,
                || format!("http GET {path} failed after all attempts"),
                || {
                    let mut f = std::collections::HashMap::new();
                    f.insert("method".to_string(), "GET".to_string());
                    f.insert("path".to_string(), path.clone());
                    f.insert("attempt".to_string(), (self.max_attempts - 1).to_string());
                    f.insert("correlation_id".to_string(), corr_c);
                    f.insert("kind".to_string(), kind);
                    crate::logging::redact::redact_fields(f)
                },
            );
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
        let mut last_err = RovenueError::NetworkUnavailable();
        let corr = self.next_correlation_id();

        let payload = serde_json::to_vec(body).map_err(|_| RovenueError::Internal())?;

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
                    if let Some(l) = &self.logger {
                        let path = req.path.to_string();
                        let corr_c = corr.clone();
                        l.log(
                            crate::logging::LogLevel::Debug,
                            || format!("http POST {path}"),
                            || {
                                let mut f = std::collections::HashMap::new();
                                f.insert("method".to_string(), "POST".to_string());
                                f.insert("path".to_string(), path.clone());
                                f.insert("status".to_string(), status.to_string());
                                f.insert("attempt".to_string(), attempt.to_string());
                                f.insert("correlation_id".to_string(), corr_c);
                                crate::logging::redact::redact_fields(f)
                            },
                        );
                    }
                    let retry_after = resp
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .map(std::time::Duration::from_secs);

                    match classify(Some(status), retry_after) {
                        RetryDecision::Success => {
                            // 204 No Content is always bodyless. Other 2xx
                            // responses are parsed unless the caller opted out
                            // via `expect_empty_body` (e.g. /v1/events' empty
                            // 202) — scoped per-request so we never silently
                            // drop a body another caller actually needs.
                            let body = if status == 204 || req.expect_empty_body {
                                None
                            } else {
                                Some(resp.json::<T>().map_err(|_| RovenueError::Internal())?)
                            };
                            return Ok(HttpResponse {
                                status,
                                etag: None,
                                body,
                            });
                        }
                        RetryDecision::Retryable => {
                            last_err = if (500..600).contains(&status) {
                                RovenueError::ServerError()
                            } else {
                                RovenueError::NetworkUnavailable()
                            };
                            if attempt + 1 < self.max_attempts {
                                let d = backoff(attempt, &mut rng).max(self.min_backoff);
                                std::thread::sleep(d);
                            }
                        }
                        RetryDecision::RetryAfter(d) => {
                            if d > RETRY_AFTER_MAX {
                                return Err(RovenueError::RateLimited());
                            }
                            last_err = RovenueError::RateLimited();
                            if attempt + 1 < self.max_attempts {
                                std::thread::sleep(d.max(self.min_backoff));
                            }
                        }
                        RetryDecision::Fatal => {
                            let body_text = resp.text().unwrap_or_default();
                            let err = error_from_status(status, &body_text);
                            if let Some(l) = &self.logger {
                                let path = req.path.to_string();
                                let corr_c = corr.clone();
                                let kind = format!("{:?}", err.kind);
                                l.log(
                                    crate::logging::LogLevel::Error,
                                    || format!("http POST {path} failed"),
                                    || {
                                        let mut f = std::collections::HashMap::new();
                                        f.insert("method".to_string(), "POST".to_string());
                                        f.insert("path".to_string(), path.clone());
                                        f.insert("status".to_string(), status.to_string());
                                        f.insert("attempt".to_string(), attempt.to_string());
                                        f.insert("correlation_id".to_string(), corr_c);
                                        f.insert("kind".to_string(), kind);
                                        crate::logging::redact::redact_fields(f)
                                    },
                                );
                            }
                            return Err(err);
                        }
                    }
                }
                Err(e) if e.is_timeout() => {
                    last_err = RovenueError::Timeout();
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
                Err(_) => {
                    last_err = RovenueError::NetworkUnavailable();
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
            }
        }

        // Terminal network/timeout failure after all attempts exhausted.
        if let Some(l) = &self.logger {
            let path = req.path.to_string();
            let corr_c = corr.clone();
            let kind = format!("{:?}", last_err.kind);
            l.log(
                crate::logging::LogLevel::Error,
                || format!("http POST {path} failed after all attempts"),
                || {
                    let mut f = std::collections::HashMap::new();
                    f.insert("method".to_string(), "POST".to_string());
                    f.insert("path".to_string(), path.clone());
                    f.insert("attempt".to_string(), (self.max_attempts - 1).to_string());
                    f.insert("correlation_id".to_string(), corr_c);
                    f.insert("kind".to_string(), kind);
                    crate::logging::redact::redact_fields(f)
                },
            );
        }
        Err(last_err)
    }

    /// POST that surfaces the raw HTTP status instead of collapsing 4xx into an
    /// error. Returns `Ok((status, body))` for any 2xx or 4xx response (body is
    /// `None` when empty or non-JSON); retries 5xx/network/timeout and returns
    /// `Err` only when those are exhausted. Used by callers that map specific
    /// 4xx codes themselves (e.g. funnel claim 404/410/409).
    pub fn post_json_status<B: Serialize>(
        &self,
        req: super::types::HttpPostRequest<'_>,
        body: &B,
    ) -> RovenueResult<(u16, Option<serde_json::Value>)> {
        use super::retry::{backoff, classify, RetryDecision, RETRY_AFTER_MAX};

        let url = format!("{}{}", self.base_url, req.path);
        let mut rng = rand::thread_rng();
        let mut last_err = RovenueError::NetworkUnavailable();
        let corr = self.next_correlation_id();
        let payload = serde_json::to_vec(body).map_err(|_| RovenueError::Internal())?;

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

            match builder.body(payload.clone()).send() {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if let Some(l) = &self.logger {
                        let path = req.path.to_string();
                        let corr_c = corr.clone();
                        l.log(
                            crate::logging::LogLevel::Debug,
                            || format!("http POST {path}"),
                            || {
                                let mut f = std::collections::HashMap::new();
                                f.insert("method".to_string(), "POST".to_string());
                                f.insert("path".to_string(), path.clone());
                                f.insert("status".to_string(), status.to_string());
                                f.insert("attempt".to_string(), attempt.to_string());
                                f.insert("correlation_id".to_string(), corr_c);
                                crate::logging::redact::redact_fields(f)
                            },
                        );
                    }
                    // 4xx is a returnable outcome (caller maps it); 2xx too.
                    if (200..500).contains(&status) {
                        let parsed = resp.json::<serde_json::Value>().ok();
                        return Ok((status, parsed));
                    }
                    // 5xx (and anything else) → retry per policy.
                    let retry_after = resp
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .map(std::time::Duration::from_secs);
                    match classify(Some(status), retry_after) {
                        RetryDecision::RetryAfter(d) => {
                            if d > RETRY_AFTER_MAX {
                                return Err(RovenueError::RateLimited());
                            }
                            last_err = RovenueError::RateLimited();
                            if attempt + 1 < self.max_attempts {
                                std::thread::sleep(d.max(self.min_backoff));
                            }
                        }
                        _ => {
                            last_err = RovenueError::ServerError();
                            if attempt + 1 < self.max_attempts {
                                let d = backoff(attempt, &mut rng).max(self.min_backoff);
                                std::thread::sleep(d);
                            }
                        }
                    }
                }
                Err(e) if e.is_timeout() => {
                    last_err = RovenueError::Timeout();
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
                Err(_) => {
                    last_err = RovenueError::NetworkUnavailable();
                    if attempt + 1 < self.max_attempts {
                        let d = backoff(attempt, &mut rng).max(self.min_backoff);
                        std::thread::sleep(d);
                    }
                }
            }
        }

        // Terminal network/timeout failure after all attempts exhausted.
        if let Some(l) = &self.logger {
            let path = req.path.to_string();
            let corr_c = corr.clone();
            let kind = format!("{:?}", last_err.kind);
            l.log(
                crate::logging::LogLevel::Error,
                || format!("http POST {path} failed after all attempts"),
                || {
                    let mut f = std::collections::HashMap::new();
                    f.insert("method".to_string(), "POST".to_string());
                    f.insert("path".to_string(), path.clone());
                    f.insert("attempt".to_string(), (self.max_attempts - 1).to_string());
                    f.insert("correlation_id".to_string(), corr_c);
                    f.insert("kind".to_string(), kind);
                    crate::logging::redact::redact_fields(f)
                },
            );
        }
        Err(last_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_level_logs_request_metadata_without_authorization() {
        use crate::logging::{LogLevel, LogRecord, LogSink, Logger};
        use std::sync::Mutex as StdMutex;
        struct Collector(std::sync::Arc<StdMutex<Vec<LogRecord>>>);
        impl LogSink for Collector {
            fn on_log(&self, r: LogRecord) {
                self.0.lock().unwrap().push(r);
            }
        }
        let recs = std::sync::Arc::new(StdMutex::new(Vec::new()));
        let logger = std::sync::Arc::new(Logger::new(LogLevel::Debug));
        logger.set_sink(std::sync::Arc::new(Collector(recs.clone())));

        // Point at an unroutable local port so the request fails fast; we only
        // assert on the emitted trace metadata, not on a live response.
        let client = HttpClient::new("http://127.0.0.1:1".to_string(), "pk_secret".to_string())
            .with_max_attempts(1)
            .with_logger(logger);
        let _ = client.get_json::<serde_json::Value>(HttpRequest::new("/v1/entitlements"));

        let got = recs.lock().unwrap();
        assert!(
            got.iter().any(|r| r
                .fields
                .get("path")
                .map(|p| p == "/v1/entitlements")
                .unwrap_or(false)),
            "expected a record carrying the request path"
        );
        for r in got.iter() {
            for v in r.fields.values() {
                assert!(!v.contains("pk_secret"), "api key leaked into trace: {v}");
            }
            assert!(
                !r.message.contains("pk_secret"),
                "api key leaked into message: {}",
                r.message
            );
            assert!(
                !r.fields.contains_key("Authorization") && !r.fields.contains_key("authorization"),
                "Authorization must never be a logged field"
            );
        }
    }
}

#[cfg(test)]
mod post_json_tests {
    use super::super::types::HttpPostRequest;
    use super::*;

    #[test]
    fn post_json_skips_body_when_expect_empty_body() {
        let mut server = mockito::Server::new();
        let m = server.mock("POST", "/v1/events").with_status(202).create();

        let client = HttpClient::new(server.url(), "pk_test".into()).with_max_attempts(1);
        let body = serde_json::json!({ "eventType": "x", "occurredAt": "2026-06-20T00:00:00Z" });
        let resp = client
            .post_json::<serde_json::Value, serde_json::Value>(
                HttpPostRequest::new("/v1/events").expect_empty_body(),
                &body,
            )
            .expect("202 must be Ok");

        assert_eq!(resp.status, 202);
        assert!(resp.body.is_none());
        m.assert();
    }

    #[test]
    fn post_json_parses_202_body_when_not_expecting_empty() {
        // Regression guard: the 202-bodyless carve-out must be scoped to
        // `expect_empty_body`, not global — other callers' 2xx bodies are kept.
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/some/endpoint")
            .with_status(202)
            .with_header("content-type", "application/json")
            .with_body(r#"{"ok":true}"#)
            .create();

        let client = HttpClient::new(server.url(), "pk_test".into()).with_max_attempts(1);
        let body = serde_json::json!({});
        let resp = client
            .post_json::<serde_json::Value, serde_json::Value>(
                HttpPostRequest::new("/v1/some/endpoint"),
                &body,
            )
            .expect("202 with body must be Ok");

        assert_eq!(resp.status, 202);
        assert_eq!(resp.body.unwrap()["ok"], serde_json::json!(true));
        m.assert();
    }
}

#[cfg(test)]
mod post_json_status_tests {
    use super::super::types::HttpPostRequest;
    use super::*;

    #[test]
    fn returns_status_and_body_for_2xx_and_4xx() {
        let mut server = mockito::Server::new();
        let m200 = server
            .mock("POST", "/ok")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"x":1}}"#)
            .create();
        let m404 = server
            .mock("POST", "/missing")
            .with_status(404)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error":{"code":"x","message":"y"}}"#)
            .create();

        let client = HttpClient::new(server.url(), "pk_test".into()).with_max_attempts(1);
        let body = serde_json::json!({"a":1});

        let (s1, b1) = client
            .post_json_status(HttpPostRequest::new("/ok"), &body)
            .expect("2xx ok");
        assert_eq!(s1, 200);
        assert_eq!(b1.unwrap()["data"]["x"], 1);

        let (s2, b2) = client
            .post_json_status(HttpPostRequest::new("/missing"), &body)
            .expect("4xx returns Ok, not Err");
        assert_eq!(s2, 404);
        assert_eq!(b2.unwrap()["error"]["code"], "x");

        m200.assert();
        m404.assert();
    }
}
