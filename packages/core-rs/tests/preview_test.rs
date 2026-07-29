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
        .get_paywall_preview("tok_abc123", None, None)
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
        .get_paywall_preview("tok_abc123", Some("tr"), None)
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
        .get_paywall_preview("tok_abc123", None, None)
        .unwrap()
        .expect("preview paywall resolved");
    m.assert();

    assert_eq!(paywall.revision, None);
}

// =============================================================
// If-None-Match wiring (P9 follow-up: client-side ETag/revision poll).
// `get_paywall_preview` takes an optional `revision` — the *unquoted* ISO
// timestamp already sitting on the currently-shown `CorePaywall.revision` —
// and, when present, sends it quoted as `If-None-Match` (matching the
// server's own `'"' + revision + '"'` ETag format, mirrored from
// `EntitlementsReader::refresh`'s `HttpRequest::etag` convention). A 304
// response means "unchanged" and surfaces as `Ok(None)` — this is the only
// case where `get_paywall_preview` returns `Ok(None)` instead of `Err` or
// `Ok(Some(_))`.
// =============================================================

#[test]
fn get_paywall_preview_sends_no_if_none_match_when_no_revision_given() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/preview/paywalls/tok_abc123")
        .match_header("if-none-match", mockito::Matcher::Missing)
        .with_status(200)
        .with_body(PREVIEW_BODY)
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    client
        .get_paywall_preview("tok_abc123", None, None)
        .unwrap()
        .expect("initial fetch (no revision) resolves the full paywall");
    m.assert();
}

#[test]
fn get_paywall_preview_sends_quoted_revision_as_if_none_match_when_given() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/preview/paywalls/tok_abc123")
        .match_header(
            "if-none-match",
            mockito::Matcher::Exact("\"2026-07-28T12:00:00.000Z\"".to_string()),
        )
        .with_status(304)
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    let result = client
        .get_paywall_preview("tok_abc123", None, Some("2026-07-28T12:00:00.000Z"))
        .unwrap();
    m.assert();

    assert!(
        result.is_none(),
        "a 304 must surface as Ok(None), not Ok(Some(_))"
    );
}

#[test]
fn get_paywall_preview_200_with_body_still_decodes_when_revision_given() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/preview/paywalls/tok_abc123")
        .match_header(
            "if-none-match",
            mockito::Matcher::Exact("\"2026-07-20T00:00:00.000Z\"".to_string()),
        )
        .with_status(200)
        .with_body(PREVIEW_BODY)
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    let paywall = client
        .get_paywall_preview("tok_abc123", None, Some("2026-07-20T00:00:00.000Z"))
        .unwrap()
        .expect("a changed revision returns 200 with the new body, not a 304");

    assert_eq!(
        paywall.revision.as_deref(),
        Some("2026-07-28T12:00:00.000Z")
    );
    m.assert();
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
        .get_paywall_preview("tok_expired", None, None)
        .expect_err("an expired/invalid preview session must be an Err, not Ok(None)");
    m.assert();

    assert_eq!(err.kind, rovenue::error::ErrorKind::NotFound);
}
