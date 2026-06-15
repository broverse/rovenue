use std::sync::Arc;
use std::time::Duration;

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
