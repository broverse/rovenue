// =============================================================
// queue.rs — durable, process-kill-safe `paywall_*` event queue (spec D4)
// =============================================================
//
// Mirrors `sessions/{buffer,dispatcher}.rs`'s discipline (peek -> POST ->
// delete-on-2xx, retain on 5xx/network) but combined into a single type
// since /v1/events takes one envelope per POST (no batching like
// /v1/sdk/sessions), and persists into its own bounded (100, drop-oldest)
// cache-store lane instead of the unbounded-until-flush session buffer.
//
// `logPaywallShown`/`logPaywallClosed` (and the renderers' auto-emit calls)
// enqueue instead of posting inline — an app killed between "paywall shown"
// and "beacon sent" no longer silently loses the impression. Delivery is
// at-least-once: the server dedupes on the deterministic event id, so a
// replayed drain after a crash-before-delete is safe.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::cache::store::PaywallEventRow;
use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};
use crate::events::{EventEnvelope, EventsClient};
use crate::logging::{LogLevel, Logger};

pub struct PaywallEventQueue {
    store: Arc<CacheStore>,
    events: Arc<EventsClient>,
    logger: Option<Arc<Logger>>,
    in_flight: AtomicBool,
}

impl PaywallEventQueue {
    pub fn new(store: Arc<CacheStore>, events: Arc<EventsClient>) -> Self {
        Self {
            store,
            events,
            logger: None,
            in_flight: AtomicBool::new(false),
        }
    }

    pub fn with_logger(mut self, logger: Arc<Logger>) -> Self {
        self.logger = Some(logger);
        self
    }

    /// Validate `envelope_json` (must parse as an `EventEnvelope` whose
    /// `eventType` starts with `paywall_` — anything else is rejected as
    /// `InvalidArgument`, this is not a general-purpose enqueue), persist it
    /// (bounded at 100 entries, drop-oldest — see
    /// `CacheStore::append_paywall_event`), then trigger a best-effort
    /// background drain. The caller (`RovenueCore::enqueue_paywall_event`)
    /// is responsible for stamping `version`/`eventId`/`subscriberId` before
    /// calling this — those fields must already be baked into
    /// `envelope_json` so a drain that runs after a `log_out()` still posts
    /// under the identity the event was actually attributed to.
    pub fn enqueue(self: &Arc<Self>, envelope_json: &str) -> RovenueResult<()> {
        let envelope: EventEnvelope =
            serde_json::from_str(envelope_json).map_err(|_| RovenueError::InvalidArgument())?;
        if !envelope.event_type.starts_with("paywall_") {
            return Err(RovenueError::InvalidArgument());
        }
        self.store.append_paywall_event(envelope_json)?;
        self.trigger_drain();
        Ok(())
    }

    /// Spawns a background thread to run [`drain_once`](Self::drain_once).
    /// Fire-and-forget and non-blocking — callers on the configure()/
    /// set_foreground() paths must never wait on network I/O here.
    pub fn trigger_drain(self: &Arc<Self>) {
        let me = Arc::clone(self);
        std::thread::spawn(move || me.drain_once());
    }

    /// Peek (oldest first) -> POST `/v1/events` -> delete on 2xx. On
    /// connectivity failure / 5xx the entry (and everything behind it) is
    /// retained and the drain stops — at-least-once delivery, safe because
    /// the server dedupes on the deterministic event id. A permanent 4xx
    /// rejection is poison: retaining it would wedge every later entry
    /// behind it forever, so it is dropped (loudly logged) and the drain
    /// continues with the next entry.
    ///
    /// Single-in-flight: a drain already running makes this call a no-op —
    /// the in-progress drain will pick up anything enqueued meanwhile since
    /// it re-peeks the store on every iteration.
    pub fn drain_once(&self) {
        if self
            .in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        while let Some(row) = self.next_row() {
            if !self.drain_one(&row) {
                break;
            }
        }
        self.in_flight.store(false, Ordering::SeqCst);
    }

    fn next_row(&self) -> Option<PaywallEventRow> {
        self.store.list_paywall_events(1).ok()?.into_iter().next()
    }

    /// Returns `true` when the caller should continue to the next entry,
    /// `false` when the drain should stop (connectivity/5xx — keep this
    /// entry and everything behind it for the next trigger).
    fn drain_one(&self, row: &PaywallEventRow) -> bool {
        let envelope: EventEnvelope = match serde_json::from_str(&row.envelope_json) {
            Ok(e) => e,
            Err(_) => {
                // Can't happen via enqueue()'s own validation, but a
                // persisted-and-now-unparseable row would wedge the queue
                // forever if retained — poison-delete defensively.
                self.log_poison(row.id, None);
                let _ = self.store.delete_paywall_events(&[row.id]);
                return true;
            }
        };
        match self
            .events
            .post(&envelope, envelope.subscriber_id.as_deref())
        {
            Ok(()) => {
                let _ = self.store.delete_paywall_events(&[row.id]);
                true
            }
            Err(err) => {
                if !err.retryable && matches!(err.http_status, Some(s) if (400..500).contains(&s)) {
                    self.log_poison(row.id, err.http_status);
                    let _ = self.store.delete_paywall_events(&[row.id]);
                    true
                } else {
                    false
                }
            }
        }
    }

    fn log_poison(&self, id: i64, http_status: Option<u16>) {
        let Some(logger) = &self.logger else { return };
        let message = format!(
            "rovenue: dropping poisoned paywall event id={id} (permanent rejection, http_status={http_status:?}) — retaining it would wedge the queue"
        );
        logger.log(
            LogLevel::Error,
            move || message,
            move || {
                let mut f = std::collections::HashMap::new();
                f.insert("op".to_string(), "enqueue_paywall_event".to_string());
                if let Some(s) = http_status {
                    f.insert("http_status".to_string(), s.to_string());
                }
                f
            },
        );
    }

    /// Test-only: number of buffered (undrained) paywall events.
    #[doc(hidden)]
    pub fn test_queue_len(&self) -> usize {
        self.store
            .list_paywall_events(usize::MAX)
            .map(|r| r.len())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::http_client::HttpClient;

    fn envelope_json(event_id: &str, event_type: &str) -> String {
        format!(
            r#"{{"eventType":"{event_type}","occurredAt":"2026-05-28T10:00:00Z","eventId":"{event_id}","subscriberId":"rov_test"}}"#
        )
    }

    fn setup(base_url: String) -> (Arc<CacheStore>, Arc<PaywallEventQueue>) {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        setup_with_store(base_url, store)
    }

    fn setup_with_store(
        base_url: String,
        store: Arc<CacheStore>,
    ) -> (Arc<CacheStore>, Arc<PaywallEventQueue>) {
        let http = Arc::new(HttpClient::new(base_url, "pk_test".to_string()).with_max_attempts(1));
        let events = Arc::new(EventsClient::new(http));
        let queue = Arc::new(PaywallEventQueue::new(Arc::clone(&store), events));
        (store, queue)
    }

    // -----------------------------------------------------------
    // Validation
    // -----------------------------------------------------------

    #[test]
    fn enqueue_rejects_malformed_json() {
        let (_store, queue) = setup("http://127.0.0.1:1".to_string());
        let err = queue.enqueue("not json").unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::InvalidArgument);
    }

    #[test]
    fn enqueue_rejects_non_paywall_event_types() {
        let (_store, queue) = setup("http://127.0.0.1:1".to_string());
        let err = queue
            .enqueue(&envelope_json("evt_1", "purchase"))
            .unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::InvalidArgument);
        assert_eq!(queue.test_queue_len(), 0);
    }

    #[test]
    fn enqueue_accepts_paywall_prefixed_event_types() {
        let (store, queue) = setup("http://127.0.0.1:1".to_string());
        queue
            .enqueue(&envelope_json("evt_1", "paywall_view"))
            .unwrap();
        queue
            .enqueue(&envelope_json("evt_2", "paywall_close"))
            .unwrap();
        assert_eq!(store.list_paywall_events(10).unwrap().len(), 2);
    }

    // -----------------------------------------------------------
    // Drain semantics (call drain_once() directly — deterministic, no
    // background-thread races; enqueue()'s own trigger_drain() is exercised
    // separately below).
    // -----------------------------------------------------------

    #[test]
    fn drain_once_deletes_after_successful_post() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .with_status(202)
            .with_header("content-type", "application/json")
            .create();

        let (store, queue) = setup(server.url());
        store
            .append_paywall_event(&envelope_json("evt_1", "paywall_view"))
            .unwrap();

        queue.drain_once();

        m.assert();
        assert_eq!(store.list_paywall_events(10).unwrap().len(), 0);
    }

    #[test]
    fn drain_once_retains_and_stops_on_503() {
        let mut server = mockito::Server::new();
        let m1 = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::Regex(r#""eventId":"evt_1""#.into()))
            .with_status(503)
            .create();
        // A second, later entry that WOULD succeed if attempted — proves the
        // drain stopped after the first failure rather than skipping ahead.
        let m2 = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::Regex(r#""eventId":"evt_2""#.into()))
            .with_status(202)
            .expect(0)
            .create();

        let (store, queue) = setup(server.url());
        store
            .append_paywall_event(&envelope_json("evt_1", "paywall_view"))
            .unwrap();
        store
            .append_paywall_event(&envelope_json("evt_2", "paywall_close"))
            .unwrap();

        queue.drain_once();

        m1.assert();
        m2.assert();
        let remaining = store.list_paywall_events(10).unwrap();
        assert_eq!(
            remaining.len(),
            2,
            "both entries retained — the drain must stop, not skip ahead"
        );
        assert!(remaining[0].envelope_json.contains("evt_1"));
        assert!(remaining[1].envelope_json.contains("evt_2"));
    }

    #[test]
    fn drain_once_retains_and_stops_on_network_error() {
        // Nothing listening on this port — a connection error, not an HTTP
        // status, exercising the "network" half of "5xx/network".
        let (store, queue) = setup("http://127.0.0.1:1".to_string());
        store
            .append_paywall_event(&envelope_json("evt_1", "paywall_view"))
            .unwrap();

        queue.drain_once();

        assert_eq!(store.list_paywall_events(10).unwrap().len(), 1);
    }

    #[test]
    fn drain_once_poison_deletes_4xx_and_continues() {
        let mut server = mockito::Server::new();
        let m1 = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::Regex(r#""eventId":"evt_poison""#.into()))
            .with_status(400)
            .create();
        let m2 = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::Regex(r#""eventId":"evt_ok""#.into()))
            .with_status(202)
            .create();

        let (store, queue) = setup(server.url());
        store
            .append_paywall_event(&envelope_json("evt_poison", "paywall_view"))
            .unwrap();
        store
            .append_paywall_event(&envelope_json("evt_ok", "paywall_close"))
            .unwrap();

        queue.drain_once();

        m1.assert();
        m2.assert();
        assert_eq!(
            store.list_paywall_events(10).unwrap().len(),
            0,
            "the poisoned entry must not wedge the good entry behind it"
        );
    }

    #[test]
    fn drain_once_processes_oldest_first() {
        let mut server = mockito::Server::new();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen_clone = Arc::clone(&seen);
        let m = server
            .mock("POST", "/v1/events")
            .with_status(202)
            .with_body_from_request(move |req| {
                let empty = Vec::new();
                let body = String::from_utf8_lossy(req.body().unwrap_or(&empty)).to_string();
                seen_clone.lock().unwrap().push(body);
                Vec::new()
            })
            .expect(3)
            .create();

        let (store, queue) = setup(server.url());
        store
            .append_paywall_event(&envelope_json("evt_a", "paywall_view"))
            .unwrap();
        store
            .append_paywall_event(&envelope_json("evt_b", "paywall_close"))
            .unwrap();
        store
            .append_paywall_event(&envelope_json("evt_c", "paywall_view"))
            .unwrap();

        queue.drain_once();

        m.assert();
        let order = seen.lock().unwrap();
        assert_eq!(order.len(), 3);
        assert!(order[0].contains("evt_a"));
        assert!(order[1].contains("evt_b"));
        assert!(order[2].contains("evt_c"));
    }

    // -----------------------------------------------------------
    // Single in-flight
    // -----------------------------------------------------------

    #[test]
    fn drain_once_is_a_noop_when_already_in_flight() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .with_status(202)
            .expect(0)
            .create();

        let (store, queue) = setup(server.url());
        store
            .append_paywall_event(&envelope_json("evt_1", "paywall_view"))
            .unwrap();

        // Simulate a drain already in progress.
        queue.in_flight.store(true, Ordering::SeqCst);
        queue.drain_once();
        m.assert();
        assert_eq!(
            store.list_paywall_events(10).unwrap().len(),
            1,
            "a concurrent drain must not touch the queue"
        );

        // Once the "in-progress" drain finishes, the next trigger works normally.
        queue.in_flight.store(false, Ordering::SeqCst);
        queue.drain_once();
        assert_eq!(store.list_paywall_events(10).unwrap().len(), 0);
    }

    // -----------------------------------------------------------
    // Kill-safety: enqueue via one store instance, drain via a fresh one
    // opened against the SAME on-disk backing file — proves the queue
    // survives a process restart, not just an in-memory struct's lifetime.
    // -----------------------------------------------------------

    #[test]
    fn kill_safety_enqueue_survives_reopening_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paywall_queue_test.sqlite3");

        {
            let store = Arc::new(CacheStore::open(&path).unwrap());
            let (_s, queue) = setup_with_store("http://127.0.0.1:1".to_string(), store);
            queue
                .enqueue(&envelope_json("evt_1", "paywall_view"))
                .unwrap();
            // `queue`/`store` drop here — simulates the process dying before
            // the background drain (spawned by enqueue()'s trigger_drain())
            // gets to run.
        }

        let mut server = mockito::Server::new();
        let m = server.mock("POST", "/v1/events").with_status(202).create();
        let store2 = Arc::new(CacheStore::open(&path).unwrap());
        assert_eq!(
            store2.list_paywall_events(10).unwrap().len(),
            1,
            "the entry must be visible to a brand-new store instance over the same file"
        );
        let (_s2, queue2) = setup_with_store(server.url(), store2);
        queue2.drain_once();

        m.assert();
        assert_eq!(_s2.list_paywall_events(10).unwrap().len(), 0);
    }

    // -----------------------------------------------------------
    // enqueue() triggers a background drain (integration-ish; polls with a
    // bounded timeout, consistent with this crate's existing style for
    // asserting on background-thread work — see polling/scheduler.rs).
    // -----------------------------------------------------------

    #[test]
    fn enqueue_triggers_a_background_drain() {
        let mut server = mockito::Server::new();
        let m = server.mock("POST", "/v1/events").with_status(202).create();
        let (store, queue) = setup(server.url());

        queue
            .enqueue(&envelope_json("evt_1", "paywall_view"))
            .unwrap();

        let mut drained = false;
        for _ in 0..50 {
            if store.list_paywall_events(10).unwrap().is_empty() {
                drained = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(drained, "enqueue() must trigger a background drain");
        m.assert();
    }
}
