use std::sync::Arc;
use std::time::Duration;

use crate::error::RovenueResult;
use crate::polling::PollingScheduler;
use crate::transport::http_client::HttpClient;

use super::buffer::SessionBuffer;

pub struct SessionDispatcher {
    buffer: Arc<SessionBuffer>,
    http: Arc<HttpClient>,
    subscriber_id_provider: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// Captured at configure() time from the host app's bundle/PackageInfo.
    /// Serialized as `""` when None to preserve the pre-0.7 wire format
    /// the backend expects.
    app_version: Option<String>,
}

impl SessionDispatcher {
    pub fn new(
        buffer: Arc<SessionBuffer>,
        http: Arc<HttpClient>,
        subscriber_id_provider: Arc<dyn Fn() -> Option<String> + Send + Sync>,
        app_version: Option<String>,
    ) -> Self {
        Self {
            buffer,
            http,
            subscriber_id_provider,
            app_version,
        }
    }

    /// Peek up to 200 events and POST to /v1/sdk/sessions, deleting them from
    /// the buffer ONLY after the server confirms receipt (2xx). On a 503
    /// (Kafka down) or network error the batch is retained and retried on the
    /// next tick — the API returns 503 precisely to signal "keep it". This is
    /// at-least-once delivery; the server derives a deterministic eventId from
    /// the event's stable fields so a replayed batch dedupes in ClickHouse.
    /// Growth is bounded by the buffer's FIFO cap (newest 1000 on append).
    pub fn flush_once(&self) -> RovenueResult<usize> {
        let Some(sub_id) = (self.subscriber_id_provider)() else {
            return Ok(0);
        };
        let rows = self.buffer.peek(200)?;
        if rows.is_empty() {
            return Ok(0);
        }
        let app_version = self.app_version.as_deref().unwrap_or("");
        let events: Vec<_> = rows
            .iter()
            .map(|r| {
                serde_json::json!({
                    "type": r.kind,
                    "occurredAt": r.occurred_at,
                    "durationMs": r.duration_ms,
                    "appVersion": app_version,
                    "sdkVersion": crate::version::SDK_VERSION,
                })
            })
            .collect();
        // Propagates on failure (5xx/network/429, or a non-poison 4xx —
        // e.g. 401/403 auth blip, 408 — see `RovenueError::is_poison`)
        // WITHOUT deleting → retained. A genuine envelope rejection
        // (400/422) is the one exception: peek returns id ASC, so
        // retaining a batch the server will never accept re-sends it every
        // tick and head-of-line-blocks all newer telemetry until the FIFO
        // cap evicts it. Drop it instead. Auth failures/key rotation must
        // NOT drop telemetry — they're retried on the next tick until the
        // key is fixed (shared predicate with `events::queue`, the durable
        // paywall-event queue's twin drain site — see Phase-D review
        // finding 1).
        if let Err(err) = self.http.post_sessions(&sub_id, &events) {
            if err.is_poison() {
                let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
                self.buffer.delete(&ids)?;
            }
            return Err(err);
        }
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        self.buffer.delete(&ids)?;
        Ok(rows.len())
    }

    pub fn start(self: Arc<Self>, scheduler: &PollingScheduler) {
        let me = Arc::clone(&self);
        scheduler.register("sessions", Duration::from_secs(30), move || {
            let _ = me.flush_once();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::CacheStore;
    use crate::sessions::SessionEventKind;

    fn setup(base_url: String) -> (Arc<SessionBuffer>, Arc<SessionDispatcher>) {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buffer = Arc::new(SessionBuffer::new(Arc::clone(&store)));
        // max_attempts=1 so a 503 fails fast without exponential backoff.
        let http = Arc::new(HttpClient::new(base_url, "pk_test".to_string()).with_max_attempts(1));
        let dispatcher = Arc::new(SessionDispatcher::new(
            Arc::clone(&buffer),
            http,
            Arc::new(|| Some("rov_test".to_string())),
            Some("1.0.0".to_string()),
        ));
        (buffer, dispatcher)
    }

    /// Regression (P1): on a 503 (Kafka down) / network error the batch must be
    /// RETAINED for the next flush — the API returns 503 precisely so the SDK
    /// keeps it. Previously flush drained-then-discarded, losing the events.
    #[test]
    fn retains_events_when_server_returns_503() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/sdk/sessions")
            .with_status(503)
            .with_body(r#"{"error":{"code":"TELEMETRY_UNAVAILABLE"}}"#)
            .create();

        let (buffer, dispatcher) = setup(server.url());
        buffer
            .record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None)
            .unwrap();

        // The flush fails; the events must NOT be deleted.
        let result = dispatcher.flush_once();
        assert!(result.is_err(), "a 503 must surface as an error");
        assert_eq!(
            buffer.peek(100).unwrap().len(),
            1,
            "events must be retained for retry after a 503"
        );
    }

    /// A permanently-rejected batch (4xx other than 429) must be DISCARDED,
    /// not retained: peek returns rows in id ASC order, so a retained
    /// poison batch would be re-sent on every tick and head-of-line-block
    /// all newer telemetry behind it until the FIFO cap evicts it.
    #[test]
    fn discards_batch_on_permanent_4xx_rejection() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/sdk/sessions")
            .with_status(400)
            .with_body(r#"{"error":{"code":"VALIDATION_ERROR"}}"#)
            .create();

        let (buffer, dispatcher) = setup(server.url());
        buffer
            .record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None)
            .unwrap();

        let result = dispatcher.flush_once();
        assert!(result.is_err(), "a 400 must still surface as an error");
        assert_eq!(
            buffer.peek(100).unwrap().len(),
            0,
            "a 4xx-rejected batch must be dropped, not poison the queue"
        );
    }

    /// Regression (Phase-D review finding 1): a 401 (invalid/rotated API
    /// key) must be RETAINED, not dropped — a key rotation or transient
    /// auth failure must not permanently drop queued session telemetry.
    #[test]
    fn retains_batch_on_401() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/sdk/sessions")
            .with_status(401)
            .with_body(r#"{"error":{"code":"INVALID_API_KEY"}}"#)
            .create();

        let (buffer, dispatcher) = setup(server.url());
        buffer
            .record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None)
            .unwrap();

        let result = dispatcher.flush_once();
        assert!(result.is_err(), "a 401 must still surface as an error");
        assert_eq!(
            buffer.peek(100).unwrap().len(),
            1,
            "a 401 must retain the batch, not drop it"
        );
    }

    /// Same as the 401 case — 403 (forbidden) is auth-adjacent, not a
    /// malformed batch, so it must be retained too.
    #[test]
    fn retains_batch_on_403() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/sdk/sessions")
            .with_status(403)
            .with_body(r#"{"error":{"code":"FORBIDDEN"}}"#)
            .create();

        let (buffer, dispatcher) = setup(server.url());
        buffer
            .record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None)
            .unwrap();

        let result = dispatcher.flush_once();
        assert!(result.is_err(), "a 403 must still surface as an error");
        assert_eq!(
            buffer.peek(100).unwrap().len(),
            1,
            "a 403 must retain the batch, not drop it"
        );
    }

    /// 408 (request timeout) is non-retryable per
    /// `ErrorKind::is_retryable()` (maps to the generic `InvalidRequest`
    /// kind) but is not a malformed-batch rejection either — must be
    /// retained, matching the review's explicit call-out.
    #[test]
    fn retains_batch_on_408() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/sdk/sessions")
            .with_status(408)
            .create();

        let (buffer, dispatcher) = setup(server.url());
        buffer
            .record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None)
            .unwrap();

        let result = dispatcher.flush_once();
        assert!(result.is_err(), "a 408 must still surface as an error");
        assert_eq!(
            buffer.peek(100).unwrap().len(),
            1,
            "a 408 must retain the batch, not drop it"
        );
    }

    /// 422 (unprocessable entity) is a genuine envelope rejection — same
    /// bucket as 400 — and must still be dropped after the narrowed
    /// predicate.
    #[test]
    fn discards_batch_on_422() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/sdk/sessions")
            .with_status(422)
            .with_body(r#"{"error":{"code":"VALIDATION_ERROR"}}"#)
            .create();

        let (buffer, dispatcher) = setup(server.url());
        buffer
            .record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None)
            .unwrap();

        let result = dispatcher.flush_once();
        assert!(result.is_err(), "a 422 must still surface as an error");
        assert_eq!(
            buffer.peek(100).unwrap().len(),
            0,
            "422 is a genuine envelope rejection and must still be dropped"
        );
    }

    #[test]
    fn deletes_events_after_successful_post() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/sdk/sessions")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("{}")
            .create();

        let (buffer, dispatcher) = setup(server.url());
        buffer
            .record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None)
            .unwrap();

        let flushed = dispatcher.flush_once().unwrap();
        assert_eq!(flushed, 1);
        assert_eq!(
            buffer.peek(100).unwrap().len(),
            0,
            "events must be removed only after the server confirms receipt"
        );
    }
}
