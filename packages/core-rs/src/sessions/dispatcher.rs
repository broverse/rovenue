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
