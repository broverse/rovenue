use std::sync::Arc;
use std::time::Duration;

use rovenue::api::RovenueCore;
use rovenue::cache::CacheStore;
use rovenue::config::Config;
use rovenue::offerings::OfferingsClient;
use rovenue::transport::http_client::HttpClient;

fn http_client(url: &str) -> HttpClient {
    HttpClient::new(url.to_string(), "pk_test".into())
        .with_max_attempts(1)
        .with_request_timeout(Duration::from_millis(500))
}

fn store() -> Arc<CacheStore> {
    Arc::new(CacheStore::open_in_memory().unwrap())
}

#[test]
fn get_offerings_maps_wire_to_ffi_and_sets_current() {
    let mut server = mockito::Server::new();
    let body = include_str!("fixtures/offerings_response.json");
    let m = server
        .mock("GET", "/v1/offerings")
        .with_status(200)
        .with_body(body)
        .match_header("authorization", "Bearer pk_test")
        .create();

    let client = OfferingsClient::new(Arc::new(http_client(&server.url())), store());
    let offerings = client.get_offerings().unwrap();
    m.assert();

    assert_eq!(offerings.current.as_deref(), Some("default"));
    assert_eq!(offerings.offerings.len(), 2);

    let first = &offerings.offerings[0];
    assert_eq!(first.identifier, "default");
    assert!(first.is_default);
    let pkg = &first.packages[0];
    // package_identifier is the slot id the SDK surfaces as Package.identifier
    assert_eq!(pkg.package_identifier, "$rc_monthly");
    // identifier is the product's own catalog id
    assert_eq!(pkg.identifier, "pro_monthly");
    assert_eq!(pkg.product_type, "SUBSCRIPTION");
    assert_eq!(pkg.apple_product_id.as_deref(), Some("com.x.pro.monthly"));
    assert_eq!(pkg.google_product_id.as_deref(), Some("pro_monthly"));

    let second = &offerings.offerings[1];
    assert_eq!(second.identifier, "promo");
    assert!(!second.is_default);
    assert_eq!(second.packages[0].package_identifier, "$rc_lifetime");
    assert_eq!(second.packages[0].google_product_id, None);
}

#[test]
fn core_get_offerings_round_trips() {
    let mut server = mockito::Server::new();
    let body = include_str!("fixtures/offerings_response.json");
    let m = server
        .mock("GET", "/v1/offerings")
        .with_status(200)
        .with_body(body)
        .create();

    let core = RovenueCore::new_for_test(Config {
        api_key: "pk_test".into(),
        base_url: server.url(),
        debug: true,
        app_version: None,
    })
    .unwrap();

    let offerings = core.get_offerings().unwrap();
    m.assert();

    assert_eq!(offerings.current.as_deref(), Some("default"));
    assert_eq!(offerings.offerings.len(), 2);
}

/// On a successful fetch the response is persisted; a subsequent fetch that
/// fails with a network-class error (here: connection refused on an unused
/// port) serves the last-known offerings instead of erroring.
#[test]
fn serves_cache_on_network_failure() {
    let cache = store();

    // First call: live 200 populates the cache.
    let mut server = mockito::Server::new();
    let body = include_str!("fixtures/offerings_response.json");
    let m = server
        .mock("GET", "/v1/offerings")
        .with_status(200)
        .with_body(body)
        .create();
    let online = OfferingsClient::new(Arc::new(http_client(&server.url())), Arc::clone(&cache));
    let first = online.get_offerings().unwrap();
    m.assert();
    assert_eq!(first.offerings.len(), 2);

    // Second call: a client pointed at an unused port (connection refused =
    // NetworkUnavailable) sharing the SAME cache → serves stale data.
    let offline = OfferingsClient::new(
        Arc::new(http_client("http://127.0.0.1:1")),
        Arc::clone(&cache),
    );
    let cached = offline.get_offerings().unwrap();
    assert_eq!(cached.current.as_deref(), Some("default"));
    assert_eq!(cached.offerings.len(), 2);
    assert_eq!(cached.offerings[0].identifier, "default");
    assert_eq!(cached.offerings[0].packages[0].package_identifier, "$rc_monthly");
    assert_eq!(cached.offerings[1].packages[0].google_product_id, None);
}

/// Network failure with an empty cache propagates the original error.
#[test]
fn propagates_error_when_no_cache() {
    let offline = OfferingsClient::new(Arc::new(http_client("http://127.0.0.1:1")), store());
    let res = offline.get_offerings();
    assert!(res.is_err(), "expected error when offline with empty cache");
}
