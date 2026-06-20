use std::sync::Arc;

use crate::error::RovenueResult;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;

use super::EventEnvelope;

/// Thin client for `POST /v1/events`. Fire-and-forget: any 2xx (the route
/// returns an empty 202) is success and the response body is ignored.
pub struct EventsClient {
    http: Arc<HttpClient>,
}

impl EventsClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    /// POST the serialized envelope to `/v1/events`. The optional `scope`
    /// travels in the `X-Rovenue-App-User-Id` header (forwarded server-side);
    /// the subscriber identity is also embedded in the envelope body.
    pub fn post(&self, envelope: &EventEnvelope, scope: Option<&str>) -> RovenueResult<()> {
        let mut req = HttpPostRequest::new("/v1/events");
        if let Some(s) = scope {
            req = req.user_scope(s);
        }
        let _ = self
            .http
            .post_json::<EventEnvelope, serde_json::Value>(req, envelope)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::IdentityContext;

    fn envelope() -> EventEnvelope {
        EventEnvelope {
            event_type: "purchase".into(),
            occurred_at: "2026-06-20T10:00:00Z".into(),
            subscriber_id: Some("user_42".into()),
            product_id: None,
            amount: Some("9.99".into()),
            currency: Some("USD".into()),
            event_source_url: None,
            identity_context: Some(IdentityContext {
                email: Some("a@b.com".into()),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn post_sends_camelcase_envelope_and_omits_none() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::JsonString(
                r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z","subscriberId":"user_42","amount":"9.99","currency":"USD","identityContext":{"email":"a@b.com"}}"#.into(),
            ))
            .with_status(202)
            .create();

        let http = Arc::new(HttpClient::new(server.url(), "pk_test".into()).with_max_attempts(1));
        EventsClient::new(http)
            .post(&envelope(), Some("user_42"))
            .expect("post ok");

        m.assert();
    }
}
