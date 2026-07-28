use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use rovenue::cache::CacheStore;
use rovenue::logging::{LogLevel, LogRecord, LogSink, Logger};
use rovenue::placements::PlacementsClient;
use rovenue::transport::http_client::HttpClient;

// =============================================================
// CRITICAL fix-round-1: the preview token rides in the URL PATH itself
// (`/v1/preview/paywalls/{token}`), not a field value or an Authorization
// header — `redact_fields` (redacts by field KEY) and `redact_message`'s
// credential-prefix scan (matches only when the WHOLE word starts with a
// known prefix) neither one catches an opaque token sitting mid-path. These
// tests capture every log record HttpClient emits for a get_paywall_preview
// call, across all three logging call sites (success, fatal 4xx,
// retry-exhausted), and assert the raw token string appears in NEITHER a
// message NOR any field value, on any of them.
// =============================================================

const PREVIEW_BODY: &str = include_str!("fixtures/preview_paywall_response.json");

/// Distinctive, never-guessable token — chosen so it can't accidentally be
/// caught by the *existing*, unrelated `tok_`-prefix credential scan in
/// `redact_message` (that scan only matches when an entire whitespace-split
/// word starts with the prefix; a token embedded mid-path never does). If
/// this string leaks into any record, the fix isn't path-aware.
const PREVIEW_TOKEN: &str = "ptv_SuperSecretPreviewSession987";

struct Collector(Arc<StdMutex<Vec<LogRecord>>>);
impl LogSink for Collector {
    fn on_log(&self, r: LogRecord) {
        self.0.lock().unwrap().push(r);
    }
}

fn logging_client(base_url: &str, records: &Arc<StdMutex<Vec<LogRecord>>>) -> HttpClient {
    let logger = Arc::new(Logger::new(LogLevel::Debug));
    logger.set_sink(Arc::new(Collector(records.clone())));
    HttpClient::new(base_url.to_string(), "pk_test".into())
        .with_max_attempts(1)
        .with_request_timeout(Duration::from_millis(500))
        .with_logger(logger)
}

fn store() -> Arc<CacheStore> {
    Arc::new(CacheStore::open_in_memory().unwrap())
}

/// Assert no captured record's message or any field value contains the raw
/// token — the caller passes in which branch produced `records` purely for
/// a useful panic message.
fn assert_token_never_leaked(records: &[LogRecord], branch: &str) {
    assert!(
        !records.is_empty(),
        "{branch}: expected at least one log record"
    );
    for r in records {
        assert!(
            !r.message.contains(PREVIEW_TOKEN),
            "{branch}: preview token leaked into log message: {}",
            r.message
        );
        for (k, v) in &r.fields {
            assert!(
                !v.contains(PREVIEW_TOKEN),
                "{branch}: preview token leaked into log field {k:?}: {v}"
            );
        }
    }
}

#[test]
fn preview_token_never_leaks_on_success() {
    let mut server = mockito::Server::new();
    let path = format!("/v1/preview/paywalls/{PREVIEW_TOKEN}");
    let m = server
        .mock("GET", path.as_str())
        .with_status(200)
        .with_body(PREVIEW_BODY)
        .create();

    let records = Arc::new(StdMutex::new(Vec::new()));
    let client = PlacementsClient::new(Arc::new(logging_client(&server.url(), &records)), store());
    client
        .get_paywall_preview(PREVIEW_TOKEN, None)
        .expect("preview fetch succeeds");
    m.assert();

    assert_token_never_leaked(&records.lock().unwrap(), "success (200 Debug log)");
}

#[test]
fn preview_token_never_leaks_on_fatal_4xx() {
    let mut server = mockito::Server::new();
    let path = format!("/v1/preview/paywalls/{PREVIEW_TOKEN}");
    let m = server
        .mock("GET", path.as_str())
        .with_status(404)
        .with_body(r#"{"error":{"code":"PREVIEW_SESSION_INVALID","message":"expired"}}"#)
        .create();

    let records = Arc::new(StdMutex::new(Vec::new()));
    let client = PlacementsClient::new(Arc::new(logging_client(&server.url(), &records)), store());
    let err = client
        .get_paywall_preview(PREVIEW_TOKEN, None)
        .expect_err("404 must be an error");
    m.assert();
    assert_eq!(err.kind, rovenue::ErrorKind::NotFound);

    assert_token_never_leaked(&records.lock().unwrap(), "fatal 4xx (Error log)");
}

#[test]
fn preview_token_never_leaks_on_retry_exhausted() {
    let records = Arc::new(StdMutex::new(Vec::new()));
    // Unroutable address: every attempt fails at the transport layer, driving
    // the "terminal network/timeout failure after all attempts exhausted"
    // logging branch.
    let client = PlacementsClient::new(
        Arc::new(logging_client("http://127.0.0.1:1", &records)),
        store(),
    );
    client
        .get_paywall_preview(PREVIEW_TOKEN, None)
        .expect_err("unroutable address must fail");

    assert_token_never_leaked(&records.lock().unwrap(), "retry-exhausted (Error log)");
}

#[test]
fn preview_token_never_leaks_with_locale_query_param() {
    let mut server = mockito::Server::new();
    let path = format!("/v1/preview/paywalls/{PREVIEW_TOKEN}");
    let m = server
        .mock("GET", format!("{path}?locale=tr").as_str())
        .with_status(200)
        .with_body(PREVIEW_BODY)
        .create();

    let records = Arc::new(StdMutex::new(Vec::new()));
    let client = PlacementsClient::new(Arc::new(logging_client(&server.url(), &records)), store());
    client
        .get_paywall_preview(PREVIEW_TOKEN, Some("tr"))
        .expect("preview fetch succeeds");
    m.assert();

    assert_token_never_leaked(&records.lock().unwrap(), "success with locale query");
}

/// Regression guard: the fix must not touch logging for ordinary (non-preview)
/// paths — the path field/message must still carry the full, unredacted path.
#[test]
fn non_preview_path_logging_is_unaffected() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/me/entitlements")
        .with_status(200)
        .with_body(r#"{"entitlements": []}"#)
        .create();

    let records = Arc::new(StdMutex::new(Vec::new()));
    let client = logging_client(&server.url(), &records);
    let _ = client.get_json::<serde_json::Value>(
        rovenue::transport::http_client::HttpRequest::new("/v1/me/entitlements"),
    );
    m.assert();

    let got = records.lock().unwrap();
    assert!(
        got.iter().any(|r| r
            .fields
            .get("path")
            .map(|p| p == "/v1/me/entitlements")
            .unwrap_or(false)),
        "non-preview path must still be logged verbatim"
    );
}
