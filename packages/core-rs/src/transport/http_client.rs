use std::time::Duration;

use reqwest::blocking::Client;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{RovenueError, RovenueResult};

use super::retry::{backoff, classify, RetryDecision};
use super::types::HttpResponse;

pub use super::types::HttpRequest;
pub use super::types::HttpPostRequest;

pub struct HttpClient {
    base_url: String,
    api_key: String,
    inner: Client,
    max_attempts: u32,
    min_backoff: Duration,
    request_timeout: Duration,
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
        }
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
                            let body = if status == 204 {
                                None
                            } else {
                                Some(resp.json::<T>().map_err(|_| RovenueError::Internal)?)
                            };
                            return Ok(HttpResponse { status, etag: None, body });
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
