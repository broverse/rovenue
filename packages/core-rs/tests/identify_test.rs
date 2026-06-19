use std::sync::Arc;
use std::time::Duration;

use rovenue::api::RovenueCore;
use rovenue::config::Config;
use rovenue::identify::IdentifyClient;
use rovenue::transport::http_client::HttpClient;

fn http(url: &str) -> HttpClient {
    HttpClient::new(url.to_string(), "pk_test".into())
        .with_max_attempts(1)
        .with_request_timeout(Duration::from_millis(500))
}

#[test]
fn identify_client_posts_rovenue_and_app_user_id() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/identify")
        .match_header("authorization", "Bearer pk_test")
        .match_header("x-rovenue-app-user-id", "rov_x")
        .match_body(mockito::Matcher::PartialJsonString(
            r#"{"rovenueId":"rov_x","appUserId":"user_1"}"#.into(),
        ))
        .with_status(200)
        .with_body(include_str!("fixtures/identify_response.json"))
        .create();
    let client = IdentifyClient::new(Arc::new(http(&server.url())));
    let res = client.identify("rov_x", "user_1").unwrap();
    m.assert();
    assert_eq!(res.transferred, false);
    assert_eq!(res.subscriber_id, "sub_1");
    assert_eq!(res.app_user_id, "user_1");
}

fn core(url: String) -> RovenueCore {
    RovenueCore::new_for_test(Config {
        api_key: "pk_test".into(),
        base_url: url,
        debug: true,
        app_version: None,
        platform: None,
        environment: None,
    })
    .unwrap()
}

#[test]
fn core_identify_posts_once_and_marks_synced() {
    let mut server = mockito::Server::new();
    // Exactly one POST: the optimistic identify() call. A follow-up reconcile
    // must be a no-op (row already synced), so .expect(1) catches double-posts.
    let m = server
        .mock("POST", "/v1/identify")
        .with_status(200)
        .with_body(include_str!("fixtures/identify_response.json"))
        .expect(1)
        .create();

    let core = core(server.url());
    core.identify("user_1".into()).unwrap();
    assert_eq!(core.current_user().app_user_id.as_deref(), Some("user_1"));

    // Reconcile should not POST again — the row is synced.
    core.reconcile_identity();
    m.assert();
}

#[test]
fn core_identify_optimistic_when_server_down_then_reconcile_syncs() {
    let mut server = mockito::Server::new();
    // First, the server errors on identify — identify() must still succeed.
    let fail = server
        .mock("POST", "/v1/identify")
        .with_status(500)
        .expect_at_least(1)
        .create();

    let core = core(server.url());
    // Optimistic: returns Ok and sets the user even though the POST 500s.
    core.identify("user_1".into()).unwrap();
    assert_eq!(core.current_user().app_user_id.as_deref(), Some("user_1"));
    fail.assert();

    // Now the server recovers; reconcile performs the POST and clears pending.
    server.reset();
    let ok = server
        .mock("POST", "/v1/identify")
        .match_body(mockito::Matcher::PartialJsonString(
            r#"{"appUserId":"user_1"}"#.into(),
        ))
        .with_status(200)
        .with_body(include_str!("fixtures/identify_response.json"))
        .expect(1)
        .create();

    core.reconcile_identity();
    ok.assert();

    // A second reconcile is a no-op (already synced) — no extra POST.
    let none = server.mock("POST", "/v1/identify").expect(0).create();
    core.reconcile_identity();
    none.assert();
}
