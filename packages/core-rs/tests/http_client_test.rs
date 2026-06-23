use std::time::Duration;

use rovenue::transport::http_client::{HttpClient, HttpRequest};
use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
struct DummyEntitlements {
    entitlements: Vec<String>,
}

fn client(server_url: &str) -> HttpClient {
    HttpClient::new(server_url.to_string(), "pk_test_abc".into())
        .with_max_attempts(2)
        .with_request_timeout(Duration::from_millis(500))
}

#[test]
fn happy_path_get_returns_body_and_etag() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_header("ETag", "\"abc\"")
        .with_body(r#"{"entitlements": ["pro"]}"#)
        .match_header("authorization", "Bearer pk_test_abc")
        .match_header("x-rovenue-app-user-id", "anon_123")
        .create();

    let c = client(&server.url());
    let resp = c
        .get_json::<DummyEntitlements>(
            HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"),
        )
        .unwrap();
    assert_eq!(resp.status, 200);
    assert_eq!(resp.etag.as_deref(), Some("\"abc\""));
    assert_eq!(resp.body.unwrap().entitlements, vec!["pro"]);
    m.assert();
}

#[test]
fn if_none_match_header_added_when_etag_provided() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .match_header("if-none-match", "\"abc\"")
        .with_status(304)
        .create();

    let c = client(&server.url());
    let resp = c
        .get_json::<DummyEntitlements>(
            HttpRequest::new("/v1/me/entitlements")
                .user_scope("anon_123")
                .etag("\"abc\""),
        )
        .unwrap();
    assert_eq!(resp.status, 304);
    assert!(resp.body.is_none(), "304 has no body");
    m.assert();
}

#[test]
fn retries_on_503_then_succeeds() {
    let mut server = mockito::Server::new();
    let m1 = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(503)
        .expect(1)
        .create();
    let m2 = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_body(r#"{"entitlements": []}"#)
        .expect(1)
        .create();

    let c = client(&server.url())
        .with_max_attempts(3)
        .with_min_backoff(Duration::from_millis(1));
    let resp = c
        .get_json::<DummyEntitlements>(
            HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"),
        )
        .unwrap();
    assert_eq!(resp.status, 200);
    m1.assert();
    m2.assert();
}

#[test]
fn forbidden_is_fatal_no_retry() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(403)
        .expect(1)
        .create();

    let c = client(&server.url()).with_max_attempts(5);
    let err = c
        .get_json::<DummyEntitlements>(
            HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"),
        )
        .unwrap_err();
    assert_eq!(err.kind, rovenue::ErrorKind::Forbidden);
    m.assert();
}

#[test]
fn rate_limited_then_success_within_budget() {
    let mut server = mockito::Server::new();
    let m1 = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(429)
        .with_header("Retry-After", "0")
        .expect(1)
        .create();
    let m2 = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_body(r#"{"entitlements": []}"#)
        .expect(1)
        .create();

    let c = client(&server.url())
        .with_max_attempts(3)
        .with_min_backoff(Duration::from_millis(1));
    let resp = c
        .get_json::<DummyEntitlements>(
            HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"),
        )
        .unwrap();
    assert_eq!(resp.status, 200);
    m1.assert();
    m2.assert();
}

#[test]
fn rate_limited_exceeds_max_wait_surfaces_error() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(429)
        .with_header("Retry-After", "120")
        .expect(1)
        .create();

    let c = client(&server.url()).with_max_attempts(3);
    let err = c
        .get_json::<DummyEntitlements>(
            HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"),
        )
        .unwrap_err();
    assert_eq!(err.kind, rovenue::ErrorKind::RateLimited);
    m.assert();
}

#[test]
fn rate_limited_budget_exhausted_surfaces_error() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(429)
        .with_header("Retry-After", "0")
        .expect(2)
        .create();

    let c = client(&server.url())
        .with_max_attempts(2)
        .with_min_backoff(Duration::from_millis(1));
    let err = c
        .get_json::<DummyEntitlements>(
            HttpRequest::new("/v1/me/entitlements").user_scope("anon_123"),
        )
        .unwrap_err();
    assert_eq!(err.kind, rovenue::ErrorKind::RateLimited);
    m.assert();
}

#[test]
fn post_attributes_sends_attributes_map_to_me_endpoint() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/me/attributes")
        .match_header("authorization", "Bearer pk_test_abc")
        .match_header("x-rovenue-app-user-id", "rov_x")
        .match_body(mockito::Matcher::JsonString(
            r#"{"attributes":{"$email":"a@b.com","country":null}}"#.into(),
        ))
        .with_status(200)
        .with_body(r#"{"data":{"ok":true}}"#)
        .create();

    let mut attributes = serde_json::Map::new();
    attributes.insert(
        "$email".to_string(),
        serde_json::Value::String("a@b.com".to_string()),
    );
    attributes.insert("country".to_string(), serde_json::Value::Null);

    let c = client(&server.url());
    c.post_attributes("rov_x", &attributes).unwrap();
    m.assert();
}
