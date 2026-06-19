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
fn post_google_success() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("POST", "/v1/receipts/google")
        .match_header("authorization", "Bearer pk_test")
        .match_header("x-rovenue-app-user-id", "anon_99")
        .match_header("idempotency-key", "idem_google_001")
        .match_body(r#"{"receipt":"play.purchase.token","appUserId":"anon_99","productId":"pro_monthly_v2"}"#)
        .with_status(200)
        .with_body(r#"{"data":{"subscriber":{"id":"sub_2","appUserId":"anon_99"},"access":{},"virtualCurrencyBalances":{"gold":5}}}"#)
        .create();

    let c = ReceiptClient::new(http(&server.url()));
    let result = c
        .post_google(
            "play.purchase.token",
            "anon_99",
            "pro_monthly_v2",
            "idem_google_001",
            None,
            None,
        )
        .unwrap();
    assert_eq!(result.subscriber_id, "sub_2");
    assert_eq!(result.virtual_currencies.get("gold"), Some(&5));
    m.assert();
}
