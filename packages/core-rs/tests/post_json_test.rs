use std::time::Duration;

use rovenue::transport::http_client::HttpClient;
use rovenue::transport::types::HttpPostRequest;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct Body {
    amount: u32,
}

#[derive(Debug, Deserialize, PartialEq)]
struct Response {
    data: BodyOut,
}

#[derive(Debug, Deserialize, PartialEq)]
struct BodyOut {
    balance: u32,
}

fn client(url: &str) -> HttpClient {
    HttpClient::new(url.to_string(), "pk_test_abc".into())
        .with_max_attempts(2)
        .with_request_timeout(Duration::from_millis(500))
}

#[test]
fn post_json_sends_idempotency_key_and_body() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/me/credits/spend")
        .match_header("authorization", "Bearer pk_test_abc")
        .match_header("x-rovenue-app-user-id", "anon_42")
        .match_header("idempotency-key", "idem_test_123")
        .match_header("content-type", "application/json")
        .match_body(r#"{"amount":10}"#)
        .with_status(200)
        .with_body(r#"{"data":{"balance":90}}"#)
        .create();

    let c = client(&server.url());
    let resp = c
        .post_json::<Body, Response>(
            HttpPostRequest::new("/v1/me/credits/spend")
                .user_scope("anon_42")
                .idempotency_key("idem_test_123"),
            &Body { amount: 10 },
        )
        .unwrap();
    assert_eq!(resp.status, 200);
    assert_eq!(resp.body.unwrap().data.balance, 90);
    m.assert();
}

#[test]
fn post_json_idempotent_replay_header_observed() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/me/credits/spend")
        .match_header("idempotency-key", "idem_test_xyz")
        .with_status(200)
        .with_header("Idempotent-Replay", "true")
        .with_body(r#"{"data":{"balance":50}}"#)
        .create();

    let c = client(&server.url());
    let resp = c
        .post_json::<Body, Response>(
            HttpPostRequest::new("/v1/me/credits/spend")
                .user_scope("anon_42")
                .idempotency_key("idem_test_xyz"),
            &Body { amount: 5 },
        )
        .unwrap();
    assert_eq!(resp.status, 200);
    m.assert();
}

#[test]
fn post_json_422_idempotency_conflict_maps_to_internal() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/me/credits/spend")
        .with_status(422)
        .expect(1)
        .create();

    let c = client(&server.url()).with_max_attempts(3);
    let err = c
        .post_json::<Body, Response>(
            HttpPostRequest::new("/v1/me/credits/spend")
                .user_scope("anon_42")
                .idempotency_key("idem_conflict"),
            &Body { amount: 5 },
        )
        .unwrap_err();
    assert_eq!(err.kind, rovenue::ErrorKind::Internal);
    m.assert();
}

#[test]
fn post_json_retries_reuse_same_idempotency_key() {
    let mut server = mockito::Server::new();
    let key = "idem_reuse_test";
    let m1 = server
        .mock("POST", "/v1/me/credits/spend")
        .match_header("idempotency-key", key)
        .with_status(503)
        .expect(1)
        .create();
    let m2 = server
        .mock("POST", "/v1/me/credits/spend")
        .match_header("idempotency-key", key)
        .with_status(200)
        .with_body(r#"{"data":{"balance":42}}"#)
        .expect(1)
        .create();

    let c = client(&server.url())
        .with_max_attempts(3)
        .with_min_backoff(Duration::from_millis(1));
    let resp = c
        .post_json::<Body, Response>(
            HttpPostRequest::new("/v1/me/credits/spend")
                .user_scope("anon_42")
                .idempotency_key(key),
            &Body { amount: 5 },
        )
        .unwrap();
    assert_eq!(resp.status, 200);
    m1.assert();
    m2.assert();
}
