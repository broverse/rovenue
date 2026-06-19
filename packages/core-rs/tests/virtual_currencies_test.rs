use std::sync::{Arc, Mutex};
use std::time::Duration;

use rovenue::cache::CacheStore;
use rovenue::identity::IdentityManager;
use rovenue::observer::{ChangeEvent, Observer, ObserverBus};
use rovenue::time::SystemClock;
use rovenue::transport::http_client::HttpClient;
use rovenue::virtual_currencies::VirtualCurrencyReader;

struct Capture(Mutex<Vec<ChangeEvent>>);
impl Observer for Capture {
    fn on_change(&self, e: ChangeEvent) {
        self.0.lock().unwrap().push(e);
    }
}

fn http(url: &str) -> Arc<HttpClient> {
    Arc::new(
        HttpClient::new(url.to_string(), "pk_test".into())
            .with_max_attempts(1)
            .with_request_timeout(Duration::from_millis(500)),
    )
}

fn fixture() -> (
    Arc<CacheStore>,
    Arc<ObserverBus>,
    Arc<Capture>,
    Arc<IdentityManager>,
) {
    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let cap = Arc::new(Capture(Mutex::new(vec![])));
    bus.register(Arc::clone(&cap) as Arc<dyn Observer>);
    let identity = Arc::new(IdentityManager::new(
        Arc::clone(&store),
        Arc::clone(&bus),
        Arc::new(SystemClock),
    ));
    (store, bus, cap, identity)
}

fn reader(
    store: &Arc<CacheStore>,
    bus: &Arc<ObserverBus>,
    identity: &Arc<IdentityManager>,
    url: &str,
) -> VirtualCurrencyReader {
    VirtualCurrencyReader::new(Arc::clone(store), Arc::clone(identity))
        .with_http(http(url))
        .with_observer_bus(Arc::clone(bus))
        .with_clock(Arc::new(SystemClock))
}

#[test]
fn refresh_parses_balances_envelope_and_caches_them() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/virtual-currencies/me")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"data":{"balances":{"gold":42,"gems":7}}}"#)
        .create();

    let (store, bus, _cap, identity) = fixture();
    let reader = reader(&store, &bus, &identity, &server.url());

    reader.refresh().unwrap();

    assert_eq!(reader.balance("gold"), 42);
    assert_eq!(reader.balance("gems"), 7);
    assert_eq!(reader.balance("missing"), 0);
    let all = reader.balances();
    assert_eq!(all.get("gold"), Some(&42));
    m.assert();
}

#[test]
fn refresh_emits_virtual_currencies_changed() {
    let mut server = mockito::Server::new();
    let _m = server
        .mock("GET", "/v1/virtual-currencies/me")
        .with_status(200)
        .with_body(r#"{"data":{"balances":{"gold":1}}}"#)
        .create();

    let (store, bus, cap, identity) = fixture();
    let reader = reader(&store, &bus, &identity, &server.url());

    reader.refresh().unwrap();
    let events = cap.0.lock().unwrap().clone();
    assert!(events.contains(&ChangeEvent::VirtualCurrenciesChanged));
}

#[test]
fn refresh_no_change_does_not_re_emit() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/virtual-currencies/me")
        .with_status(200)
        .with_body(r#"{"data":{"balances":{"gold":7}}}"#)
        .expect(2)
        .create();

    let (store, bus, cap, identity) = fixture();
    let reader = reader(&store, &bus, &identity, &server.url());

    reader.refresh().unwrap();
    let after_first = cap
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|e| **e == ChangeEvent::VirtualCurrenciesChanged)
        .count();

    reader.refresh().unwrap();
    let after_second = cap
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|e| **e == ChangeEvent::VirtualCurrenciesChanged)
        .count();

    assert_eq!(
        after_first, after_second,
        "unchanged balances must not re-emit"
    );
    m.assert();
}
