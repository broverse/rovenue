use std::sync::{Arc, Mutex};
use std::time::Duration;

use rovenue::cache::CacheStore;
use rovenue::credits::CreditReader;
use rovenue::identity::IdentityManager;
use rovenue::observer::{ChangeEvent, Observer, ObserverBus};
use rovenue::time::SystemClock;
use rovenue::transport::http_client::HttpClient;

struct Capture(Mutex<Vec<ChangeEvent>>);
impl Observer for Capture {
    fn on_change(&self, e: ChangeEvent) { self.0.lock().unwrap().push(e); }
}

fn http(url: &str) -> Arc<HttpClient> {
    Arc::new(
        HttpClient::new(url.to_string(), "pk_test".into())
            .with_max_attempts(1)
            .with_request_timeout(Duration::from_millis(500)),
    )
}

fn fixture() -> (Arc<CacheStore>, Arc<ObserverBus>, Arc<Capture>, Arc<IdentityManager>) {
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

#[test]
fn refresh_populates_balance_and_emits_observer() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/credits")
        .with_status(200)
        .with_body(r#"{"data":{"balance":42}}"#)
        .create();

    let (store, bus, cap, identity) = fixture();
    let reader = CreditReader::new(Arc::clone(&store), Arc::clone(&identity))
        .with_http(http(&server.url()))
        .with_observer_bus(Arc::clone(&bus))
        .with_clock(Arc::new(SystemClock));

    assert_eq!(reader.balance().unwrap(), 0);

    reader.refresh().unwrap();
    assert_eq!(reader.balance().unwrap(), 42);

    let events = cap.0.lock().unwrap().clone();
    assert!(events.contains(&ChangeEvent::CreditBalanceChanged));
    m.assert();
}

#[test]
fn refresh_no_change_when_balance_same() {
    let mut server = mockito::Server::new();
    let first = server
        .mock("GET", "/v1/me/credits")
        .with_status(200)
        .with_body(r#"{"data":{"balance":7}}"#)
        .expect(2)
        .create();

    let (store, bus, cap, identity) = fixture();
    let reader = CreditReader::new(Arc::clone(&store), Arc::clone(&identity))
        .with_http(http(&server.url()))
        .with_observer_bus(Arc::clone(&bus))
        .with_clock(Arc::new(SystemClock));

    reader.refresh().unwrap();
    let count_after_first = cap.0.lock().unwrap().iter()
        .filter(|e| **e == ChangeEvent::CreditBalanceChanged).count();

    reader.refresh().unwrap();
    let count_after_second = cap.0.lock().unwrap().iter()
        .filter(|e| **e == ChangeEvent::CreditBalanceChanged).count();
    assert_eq!(count_after_first, count_after_second, "unchanged balance must not re-emit");
    first.assert();
}

#[test]
fn consume_decrements_balance_and_emits() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/me/credits/spend")
        .match_header("idempotency-key", "idem_spend_1")
        .match_body(r#"{"amount":10}"#)
        .with_status(200)
        .with_body(r#"{"data":{"balance":40,"ledgerEntry":{"id":"le_1","amount":-10,"balance":40,"type":"spend","createdAt":"2030-01-01T00:00:00.000Z"}}}"#)
        .create();

    let (store, bus, cap, identity) = fixture();
    let reader = CreditReader::new(Arc::clone(&store), Arc::clone(&identity))
        .with_http(http(&server.url()))
        .with_observer_bus(Arc::clone(&bus))
        .with_clock(Arc::new(SystemClock));

    let new_balance = reader.consume(10, None, "idem_spend_1").unwrap();
    assert_eq!(new_balance, 40);
    assert_eq!(reader.balance().unwrap(), 40);
    let events = cap.0.lock().unwrap().clone();
    assert!(events.contains(&ChangeEvent::CreditBalanceChanged));
    m.assert();
}

#[test]
fn consume_402_returns_insufficient_credits() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/me/credits/spend")
        .with_status(402)
        .with_body(r#"{"error":{"code":"INSUFFICIENT_CREDITS","message":"Insufficient credits: 5 available, 10 requested"}}"#)
        .create();

    let (store, _bus, _cap, identity) = fixture();
    let reader = CreditReader::new(Arc::clone(&store), Arc::clone(&identity))
        .with_http(http(&server.url()))
        .with_observer_bus(Arc::new(rovenue::observer::ObserverBus::default()))
        .with_clock(Arc::new(SystemClock));

    let err = reader.consume(10, None, "idem_spend_fail").unwrap_err();
    assert!(matches!(err, rovenue::RovenueError::InsufficientCredits));
    m.assert();
}
