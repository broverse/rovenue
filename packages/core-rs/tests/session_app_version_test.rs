// Verifies the SessionDispatcher serializes the configured app_version
// into each event's `appVersion` field on the wire payload.
//
// Uses mockito to capture the request body and parse it back as JSON.

use std::sync::Arc;
use std::time::Duration;

use rovenue::cache::CacheStore;
use rovenue::config::Config;
use rovenue::sessions::dispatcher::SessionDispatcher;
use rovenue::sessions::{SessionBuffer, SessionEventKind};
use rovenue::transport::http_client::HttpClient;

fn make_dispatcher(
    base_url: &str,
    app_version: Option<String>,
) -> (Arc<SessionBuffer>, Arc<SessionDispatcher>) {
    let store = Arc::new(CacheStore::open_in_memory().unwrap());
    let buf = Arc::new(SessionBuffer::new(Arc::clone(&store)));
    let http = Arc::new(
        HttpClient::new(base_url.to_string(), "pk_test_abc".into())
            .with_max_attempts(1)
            .with_request_timeout(Duration::from_millis(500)),
    );
    let dispatcher = Arc::new(SessionDispatcher::new(
        Arc::clone(&buf),
        Arc::clone(&http),
        Arc::new(|| Some("anon_test_subscriber".to_string())),
        app_version,
    ));
    (buf, dispatcher)
}

#[test]
fn dispatcher_includes_configured_app_version_in_payload() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/sdk/sessions")
        .match_header("authorization", "Bearer pk_test_abc")
        .match_body(mockito::Matcher::PartialJsonString(
            r#"{"events":[{"appVersion":"1.2.3"}]}"#.into(),
        ))
        .with_status(200)
        .with_body(r#"{"data":{"ok":true}}"#)
        .create();

    let (buf, dispatcher) = make_dispatcher(&server.url(), Some("1.2.3".into()));
    buf.record(SessionEventKind::Open, "2026-05-29T10:00:00Z", None)
        .unwrap();

    let drained = dispatcher.flush_once().unwrap();
    assert_eq!(drained, 1);
    m.assert();
}

#[test]
fn dispatcher_serializes_empty_app_version_when_none() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/sdk/sessions")
        .match_body(mockito::Matcher::PartialJsonString(
            r#"{"events":[{"appVersion":""}]}"#.into(),
        ))
        .with_status(200)
        .with_body(r#"{"data":{"ok":true}}"#)
        .create();

    let (buf, dispatcher) = make_dispatcher(&server.url(), None);
    buf.record(SessionEventKind::Open, "2026-05-29T10:00:00Z", None)
        .unwrap();

    dispatcher.flush_once().unwrap();
    m.assert();
}

#[test]
fn config_accepts_optional_app_version() {
    let cfg = Config::new(
        "pk_test_abc".into(),
        "https://api.rovenue.io".into(),
    )
    .unwrap()
    .with_app_version(Some("4.5.6".into()));
    assert_eq!(cfg.app_version.as_deref(), Some("4.5.6"));
}
