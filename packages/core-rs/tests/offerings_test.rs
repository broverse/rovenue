use std::sync::Arc;
use std::time::Duration;

use rovenue::api::RovenueCore;
use rovenue::config::Config;
use rovenue::offerings::OfferingsClient;
use rovenue::transport::http_client::HttpClient;

fn http_client(url: &str) -> HttpClient {
    HttpClient::new(url.to_string(), "pk_test".into())
        .with_max_attempts(1)
        .with_request_timeout(Duration::from_millis(500))
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

    let client = OfferingsClient::new(Arc::new(http_client(&server.url())));
    let offerings = client.get_offerings().unwrap();
    m.assert();

    assert_eq!(offerings.current.as_deref(), Some("default"));
    assert_eq!(offerings.offerings.len(), 2);

    let first = &offerings.offerings[0];
    assert_eq!(first.identifier, "default");
    assert!(first.is_default);
    let pkg = &first.packages[0];
    assert_eq!(pkg.identifier, "monthly");
    assert_eq!(pkg.product_type, "SUBSCRIPTION");
    assert_eq!(pkg.apple_product_id.as_deref(), Some("com.x.pro.monthly"));
    assert_eq!(pkg.google_product_id.as_deref(), Some("pro_monthly"));

    let second = &offerings.offerings[1];
    assert_eq!(second.identifier, "promo");
    assert!(!second.is_default);
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
