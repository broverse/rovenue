use serde::de::DeserializeOwned;

pub struct HttpRequest<'a> {
    pub path: &'a str,
    pub user_scope: Option<&'a str>,
    /// Subscriber identity sent as the `X-Rovenue-User-Id` header. Used by the
    /// subscriber-scoped public endpoints (`/v1/config`, `/v1/offerings`,
    /// `/v1/experiments`) which read this header rather than the
    /// `X-Rovenue-App-User-Id` header that the `/v1/me/*` endpoints use.
    pub subscriber_id: Option<&'a str>,
    pub etag: Option<&'a str>,
}

impl<'a> HttpRequest<'a> {
    pub fn new(path: &'a str) -> Self {
        Self {
            path,
            user_scope: None,
            subscriber_id: None,
            etag: None,
        }
    }
    pub fn user_scope(mut self, scope: &'a str) -> Self {
        self.user_scope = Some(scope);
        self
    }
    pub fn subscriber_id(mut self, subscriber_id: &'a str) -> Self {
        self.subscriber_id = Some(subscriber_id);
        self
    }
    pub fn etag(mut self, etag: &'a str) -> Self {
        self.etag = Some(etag);
        self
    }
}

#[derive(Debug)]
pub struct HttpResponse<T> {
    pub status: u16,
    pub etag: Option<String>,
    pub body: Option<T>,
}

#[allow(dead_code)]
pub(crate) fn _assert_deserialize<T: DeserializeOwned>() {}

pub struct HttpPostRequest<'a> {
    pub path: &'a str,
    pub user_scope: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
    /// When true the caller declares the success response carries no body, so
    /// `post_json` skips parsing it (e.g. `/v1/events` returns an empty 202).
    /// Scoped per-request so other callers keep parsing their 2xx bodies.
    pub expect_empty_body: bool,
}

impl<'a> HttpPostRequest<'a> {
    pub fn new(path: &'a str) -> Self {
        Self {
            path,
            user_scope: None,
            idempotency_key: None,
            expect_empty_body: false,
        }
    }
    pub fn user_scope(mut self, scope: &'a str) -> Self {
        self.user_scope = Some(scope);
        self
    }
    pub fn idempotency_key(mut self, key: &'a str) -> Self {
        self.idempotency_key = Some(key);
        self
    }
    pub fn expect_empty_body(mut self) -> Self {
        self.expect_empty_body = true;
        self
    }
}
