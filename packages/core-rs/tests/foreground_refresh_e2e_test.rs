use std::sync::{Arc, Mutex};
use std::time::Duration;

use rovenue::cache::CacheStore;
use rovenue::entitlements::EntitlementReader;
use rovenue::identity::IdentityManager;
use rovenue::observer::{ChangeEvent, Observer, ObserverBus};
use rovenue::polling::PollingScheduler;
use rovenue::time::SystemClock;
use rovenue::transport::http_client::HttpClient;
use serial_test::serial;

struct Capture(Mutex<Vec<ChangeEvent>>);
impl Observer for Capture {
    fn on_change(&self, e: ChangeEvent) { self.0.lock().unwrap().push(e); }
}

#[test]
#[serial]
fn polling_refresh_fires_when_foreground() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_body(r#"{"data":{"entitlements":{"pro":{"isActive":true,"expiresDate":null,"store":"APP_STORE","productIdentifier":"monthly"}}}}"#)
        .expect_at_least(1)
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
    let http = Arc::new(
        HttpClient::new(server.url(), "pk_test".into())
            .with_max_attempts(1)
            .with_request_timeout(Duration::from_millis(500)),
    );
    let reader = Arc::new(
        EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
            .with_http(Arc::clone(&http))
            .with_observer_bus(Arc::clone(&bus))
            .with_clock(Arc::new(SystemClock)),
    );

    let scheduler = PollingScheduler::new();
    {
        let r = Arc::clone(&reader);
        scheduler.register("entitlements", Duration::from_millis(40), move || {
            let _ = r.refresh();
        });
    }
    scheduler.set_foreground(true);
    std::thread::sleep(Duration::from_millis(200));
    scheduler.shutdown();

    let events = cap.0.lock().unwrap().clone();
    assert!(
        events.iter().any(|e| *e == ChangeEvent::EntitlementsChanged),
        "polling tick must have emitted at least one EntitlementsChanged"
    );
    m.assert();
}

#[test]
#[serial]
fn polling_does_not_fire_in_background() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_body(r#"{"data":{"entitlements":{}}}"#)
        .expect(0)
        .create();

    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let bus = Arc::new(ObserverBus::default());
    let identity = Arc::new(IdentityManager::new(
        Arc::clone(&store),
        Arc::clone(&bus),
        Arc::new(SystemClock),
    ));
    let http = Arc::new(
        HttpClient::new(server.url(), "pk_test".into())
            .with_max_attempts(1)
            .with_request_timeout(Duration::from_millis(500)),
    );
    let reader = Arc::new(
        EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
            .with_http(Arc::clone(&http))
            .with_observer_bus(Arc::clone(&bus))
            .with_clock(Arc::new(SystemClock)),
    );

    let scheduler = PollingScheduler::new();
    {
        let r = Arc::clone(&reader);
        scheduler.register("entitlements", Duration::from_millis(20), move || {
            let _ = r.refresh();
        });
    }
    // set_foreground(false) is the default; sleep, then assert no calls.
    std::thread::sleep(Duration::from_millis(80));
    scheduler.shutdown();
    m.assert();
}
