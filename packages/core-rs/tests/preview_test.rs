use std::sync::Arc;
use std::time::Duration;

use rovenue::cache::CacheStore;
use rovenue::placements::PlacementsClient;
use rovenue::transport::http_client::HttpClient;

fn http_client(url: &str) -> HttpClient {
    HttpClient::new(url.to_string(), "pk_test".into())
        .with_max_attempts(1)
        .with_request_timeout(Duration::from_millis(500))
}

fn store() -> Arc<CacheStore> {
    Arc::new(CacheStore::open_in_memory().unwrap())
}

const PREVIEW_BODY: &str = include_str!("fixtures/preview_paywall_response.json");
const PREVIEW_BODY_NO_REVISION: &str =
    include_str!("fixtures/preview_paywall_no_revision_response.json");

// =============================================================
// PlacementsClient::get_paywall_preview — P9 on-device preview.
// `GET /v1/preview/paywalls/{token}?locale=` returns a BARE paywall
// (ApiEnvelope<PaywallWire>), not a placement envelope — see
// packages/core-rs/src/placements/client.rs.
// =============================================================

#[test]
fn get_paywall_preview_hits_the_preview_url_and_decodes_builder_config_and_revision() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/preview/paywalls/tok_abc123")
        .with_status(200)
        .with_body(PREVIEW_BODY)
        .match_header("authorization", "Bearer pk_test")
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    let paywall = client
        .get_paywall_preview("tok_abc123", None)
        .unwrap()
        .expect("preview paywall resolved");
    m.assert();

    assert_eq!(
        paywall.paywall_identifier.as_deref(),
        Some("onboarding_draft")
    );
    assert_eq!(paywall.paywall_name.as_deref(), Some("Draft"));
    assert_eq!(paywall.config_format_version, 2);
    assert_eq!(paywall.remote_config_locale.as_deref(), Some("en"));

    let json = paywall.builder_config_json.expect("builder config present");
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
    assert_eq!(parsed["formatVersion"], 2);
    assert_eq!(parsed["root"]["children"][0]["key"], "t");

    assert_eq!(
        paywall.revision.as_deref(),
        Some("2026-07-28T12:00:00.000Z")
    );

    // A preview has no placement/experiment context to stamp.
    assert!(paywall.presented_context.is_none());
    assert!(!paywall.served_from_fallback);
}

#[test]
fn get_paywall_preview_sends_locale_query_param() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/preview/paywalls/tok_abc123?locale=tr")
        .with_status(200)
        .with_body(PREVIEW_BODY)
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    client
        .get_paywall_preview("tok_abc123", Some("tr"))
        .unwrap();
    m.assert();
}

#[test]
fn get_paywall_preview_without_revision_decodes_to_none() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/preview/paywalls/tok_abc123")
        .with_status(200)
        .with_body(PREVIEW_BODY_NO_REVISION)
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    let paywall = client
        .get_paywall_preview("tok_abc123", None)
        .unwrap()
        .expect("preview paywall resolved");
    m.assert();

    assert_eq!(paywall.revision, None);
}

#[test]
fn get_paywall_preview_propagates_404_as_error_not_none() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/preview/paywalls/tok_expired")
        .with_status(404)
        .with_body(r#"{"error":{"code":"PREVIEW_SESSION_INVALID","message":"expired"}}"#)
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    let err = client
        .get_paywall_preview("tok_expired", None)
        .expect_err("an expired/invalid preview session must be an Err, not Ok(None)");
    m.assert();

    assert_eq!(err.kind, rovenue::error::ErrorKind::NotFound);
}
