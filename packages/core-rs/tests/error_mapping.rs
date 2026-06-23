use rovenue::transport::http_client::error_from_status;
use rovenue::error::ErrorKind;

fn body() -> &'static str { r#"{"error":{"code":"BYOK_NOT_ALLOWED","message":"byok off"}}"# }

#[test]
fn maps_status_codes_to_kinds() {
    let cases = [
        (401u16, ErrorKind::InvalidApiKey),
        (402, ErrorKind::InsufficientCredits),
        (403, ErrorKind::Forbidden),
        (404, ErrorKind::NotFound),
        (400, ErrorKind::InvalidRequest),
        (422, ErrorKind::InvalidRequest),
        (409, ErrorKind::Conflict),
        (429, ErrorKind::RateLimited),
        (500, ErrorKind::ServerError),
        (503, ErrorKind::ServerError),
    ];
    for (status, kind) in cases {
        assert_eq!(error_from_status(status, body()).kind, kind, "status {status}");
    }
}

#[test]
fn preserves_backend_code_and_message() {
    let e = error_from_status(403, body());
    assert_eq!(e.server_code.as_deref(), Some("BYOK_NOT_ALLOWED"));
    assert_eq!(e.message, "byok off");
    assert_eq!(e.http_status, Some(403));
}

#[test]
fn falls_back_when_body_not_parseable() {
    let e = error_from_status(500, "<html>oops</html>");
    assert_eq!(e.kind, ErrorKind::ServerError);
    assert_eq!(e.server_code, None);
    assert!(!e.message.is_empty());
}
