use std::sync::{Arc, Mutex};
use std::time::Duration;

use rovenue::cache::CacheStore;
use rovenue::entitlements::EntitlementReader;
use rovenue::identity::IdentityManager;
use rovenue::observer::{ChangeEvent, Observer, ObserverBus};
use rovenue::time::SystemClock;
use rovenue::transport::http_client::HttpClient;

struct Capture(Mutex<Vec<ChangeEvent>>);
impl Observer for Capture {
    fn on_change(&self, e: ChangeEvent) {
        self.0.lock().unwrap().push(e);
    }
}

fn http_client(url: &str) -> HttpClient {
    HttpClient::new(url.to_string(), "pk_test".into())
        .with_max_attempts(1)
        .with_request_timeout(Duration::from_millis(500))
}

#[test]
fn refresh_populates_cache_and_emits_observer() {
    let mut server = mockito::Server::new();
    let body = include_str!("fixtures/entitlements_response.json");
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_header("ETag", "\"v1\"")
        .with_body(body)
        .match_header("authorization", "Bearer pk_test")
        .create();

    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    let identity = Arc::new(IdentityManager::new(
        Arc::clone(&store),
        Arc::clone(&bus),
        Arc::new(SystemClock),
    ));
    let reader = EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
        .with_http(Arc::new(http_client(&server.url())))
        .with_observer_bus(Arc::clone(&bus))
        .with_clock(Arc::new(SystemClock));

    // First read: empty cache → None.
    assert!(reader.get("pro").unwrap().is_none());

    // Refresh: hits HTTP, populates cache, emits observer.
    reader.refresh().unwrap();
    m.assert();

    let events = cap.0.lock().unwrap().clone();
    assert!(events.contains(&ChangeEvent::EntitlementsChanged));

    let pro = reader.get("pro").unwrap().unwrap();
    assert!(pro.is_active);
    assert_eq!(pro.product_id.as_deref(), Some("monthly"));

    let all = reader.list_all().unwrap();
    assert_eq!(all.len(), 2);
}

#[test]
fn second_refresh_sends_if_none_match_and_is_no_op_on_304() {
    let mut server = mockito::Server::new();
    let body = include_str!("fixtures/entitlements_response.json");
    let first = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_header("ETag", "\"v1\"")
        .with_body(body)
        .expect(1)
        .create();
    let second = server
        .mock("GET", "/v1/me/entitlements")
        .match_header("if-none-match", "\"v1\"")
        .with_status(304)
        .expect(1)
        .create();

    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    let identity = Arc::new(IdentityManager::new(
        Arc::clone(&store),
        Arc::clone(&bus),
        Arc::new(SystemClock),
    ));
    let reader = EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
        .with_http(Arc::new(http_client(&server.url())))
        .with_observer_bus(Arc::clone(&bus))
        .with_clock(Arc::new(SystemClock));

    reader.refresh().unwrap();
    let initial_events = cap.0.lock().unwrap().len();

    reader.refresh().unwrap();
    let after_events = cap.0.lock().unwrap().len();
    assert_eq!(after_events, initial_events, "304 must not emit a change");

    first.assert();
    second.assert();
}
