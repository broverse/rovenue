use std::sync::Arc;
use std::time::Duration;

use rovenue::receipts::ReceiptClient;
use rovenue::transport::http_client::HttpClient;

fn http(url: &str) -> Arc<HttpClient> {
    Arc::new(
        HttpClient::new(url.to_string(), "pk_test".into())
            .with_max_attempts(1)
            .with_request_timeout(Duration::from_millis(500)),
    )
}

#[test]
fn post_apple_success() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/receipts/apple")
        .match_header("authorization", "Bearer pk_test")
        .match_header("x-rovenue-app-user-id", "anon_99")
        .match_header("idempotency-key", "idem_apple_001")
        .match_body(r#"{"receipt":"<jws>","appUserId":"anon_99","productId":"pro_monthly"}"#)
        .with_status(200)
        .with_body(r#"{"data":{"subscriber":{"id":"sub_1","appUserId":"anon_99"},"access":{},"credits":{"balance":120}}}"#)
        .create();

    let c = ReceiptClient::new(http(&server.url()));
    let result = c
        .post_apple("<jws>", "anon_99", "pro_monthly", "idem_apple_001")
        .unwrap();
    assert_eq!(result.subscriber_id, "sub_1");
    assert_eq!(result.app_user_id, "anon_99");
    assert_eq!(result.credit_balance, 120);
    m.assert();
}

#[test]
fn post_apple_403_is_fatal() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/receipts/apple")
        .with_status(403)
        .expect(1)
        .create();

    let c = ReceiptClient::new(http(&server.url()));
    let err = c
        .post_apple("<jws>", "anon_99", "pro", "idem_x")
        .unwrap_err();
    assert!(matches!(err, rovenue::RovenueError::ServerError));
    m.assert();
}
