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
}

impl SessionDispatcher {
    pub fn new(
        buffer: Arc<SessionBuffer>,
        http: Arc<HttpClient>,
        subscriber_id_provider: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    ) -> Self {
        Self {
            buffer,
            http,
            subscriber_id_provider,
        }
    }

    /// Drain up to 200 events and POST to /v1/sdk/sessions. On error,
    /// re-append is NOT attempted (telemetry is best-effort; dropping
    /// is preferable to unbounded retry on a flaky network).
    pub fn flush_once(&self) -> RovenueResult<usize> {
        let Some(sub_id) = (self.subscriber_id_provider)() else {
            return Ok(0);
        };
        let rows = self.buffer.drain(200)?;
        if rows.is_empty() {
            return Ok(0);
        }
        let events: Vec<_> = rows
            .iter()
            .map(|r| {
                serde_json::json!({
                    "type": r.kind,
                    "occurredAt": r.occurred_at,
                    "durationMs": r.duration_ms,
                    "appVersion": "",
                    "sdkVersion": crate::version::SDK_VERSION,
                })
            })
            .collect();
        let _ = self.http.post_sessions(&sub_id, &events);
        Ok(rows.len())
    }

    pub fn start(self: Arc<Self>, scheduler: &PollingScheduler) {
        let me = Arc::clone(&self);
        scheduler.register("sessions", Duration::from_secs(30), move || {
            let _ = me.flush_once();
        });
    }
}
