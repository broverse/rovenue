use std::sync::Arc;
use std::time::Duration;

use crate::attributes::buffer::AttributeBuffer;
use crate::error::RovenueResult;
use crate::polling::scheduler::PollingScheduler;
use crate::transport::http_client::HttpClient;

/// Returns the current subscriber id, or None when no subscriber is
/// established yet (flush is a no-op in that case).
pub type SubscriberIdProvider = Box<dyn Fn() -> Option<String> + Send + Sync>;

pub struct AttributeDispatcher {
    buffer: Arc<AttributeBuffer>,
    http: Arc<HttpClient>,
    subscriber_id_provider: SubscriberIdProvider,
}

impl AttributeDispatcher {
    pub fn new(
        buffer: Arc<AttributeBuffer>,
        http: Arc<HttpClient>,
        subscriber_id_provider: SubscriberIdProvider,
    ) -> Self {
        Self {
            buffer,
            http,
            subscriber_id_provider,
        }
    }

    /// List → POST → delete-on-success. Returns the number of mutations
    /// flushed. On any error the queue is left intact for retry.
    pub fn flush_once(&self) -> RovenueResult<usize> {
        let Some(sub_id) = (self.subscriber_id_provider)() else {
            return Ok(0);
        };
        let rows = self.buffer.list(200)?;
        if rows.is_empty() {
            return Ok(0);
        }
        // Coalesce in id ASC order: later set of the same key wins.
        let mut map = serde_json::Map::new();
        for r in &rows {
            let v = match &r.value {
                Some(s) => serde_json::Value::String(s.clone()),
                None => serde_json::Value::Null,
            };
            map.insert(r.key.clone(), v);
        }
        // Post first; only delete if it succeeded (durable).
        self.http.post_attributes(&sub_id, &map)?;
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        self.buffer.delete(&ids)?;
        Ok(rows.len())
    }

    /// Register the periodic flush on the scheduler (30s, same cadence
    /// as sessions; only fires while foregrounded).
    pub fn start(self: Arc<Self>, scheduler: &PollingScheduler) {
        let me = Arc::clone(&self);
        scheduler.register("attributes", Duration::from_secs(30), move || {
            let _ = me.flush_once();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attributes::buffer::AttributeBuffer;
    use crate::cache::store::CacheStore;
    use std::sync::Arc;
    use std::time::Duration;

    // An HttpClient pointed at an unroutable address with a single, short
    // attempt — any actual request fails fast with a network error. Used by
    // the no-op and network-error cases (the no-op case never sends).
    fn http_unreachable() -> Arc<HttpClient> {
        Arc::new(
            HttpClient::new("http://127.0.0.1:1".to_string(), "pk_test_abc".into())
                .with_max_attempts(1)
                .with_min_backoff(Duration::from_millis(1))
                .with_request_timeout(Duration::from_millis(200)),
        )
    }

    #[test]
    fn flush_noops_without_subscriber_id() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = Arc::new(AttributeBuffer::new(Arc::clone(&store)));
        buf.set("$email", Some("a@b.com")).unwrap();
        // http would fail if called; provider returns None so it never is.
        let dispatcher = AttributeDispatcher::new(
            Arc::clone(&buf),
            http_unreachable(),
            Box::new(|| None),
        );
        assert_eq!(dispatcher.flush_once().unwrap(), 0);
        // queue is preserved
        assert_eq!(buf.list(100).unwrap().len(), 1);
    }

    #[test]
    fn flush_deletes_only_on_success() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/me/attributes")
            .match_header("x-rovenue-app-user-id", "rov_x")
            .match_body(mockito::Matcher::JsonString(
                r#"{"attributes":{"$email":"a@b.com","country":null}}"#.into(),
            ))
            .with_status(200)
            .with_body(r#"{"data":{"ok":true}}"#)
            .create();

        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = Arc::new(AttributeBuffer::new(Arc::clone(&store)));
        buf.set("$email", Some("a@b.com")).unwrap();
        buf.set("country", None).unwrap();
        let http = Arc::new(
            HttpClient::new(server.url(), "pk_test_abc".into())
                .with_max_attempts(1)
                .with_request_timeout(Duration::from_millis(500)),
        );
        let dispatcher = AttributeDispatcher::new(
            Arc::clone(&buf),
            http,
            Box::new(|| Some("rov_x".to_string())),
        );
        assert_eq!(dispatcher.flush_once().unwrap(), 2);
        assert_eq!(buf.list(100).unwrap().len(), 0);
        m.assert();
    }

    #[test]
    fn flush_keeps_queue_on_network_error() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = Arc::new(AttributeBuffer::new(Arc::clone(&store)));
        buf.set("$email", Some("a@b.com")).unwrap();
        let dispatcher = AttributeDispatcher::new(
            Arc::clone(&buf),
            http_unreachable(),
            Box::new(|| Some("rov_x".to_string())),
        );
        assert!(dispatcher.flush_once().is_err());
        // NOT deleted — durable retry
        assert_eq!(buf.list(100).unwrap().len(), 1);
    }
}
