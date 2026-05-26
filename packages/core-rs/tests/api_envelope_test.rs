use rovenue::transport::api::ApiEnvelope;
use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
struct Payload {
    name: String,
    count: u32,
}

#[test]
fn unwraps_data_envelope() {
    let json = r#"{"data": {"name": "pro", "count": 7}}"#;
    let env: ApiEnvelope<Payload> = serde_json::from_str(json).unwrap();
    assert_eq!(
        env.data,
        Payload {
            name: "pro".into(),
            count: 7
        }
    );
}

#[test]
fn rejects_missing_data_field() {
    let json = r#"{"name": "pro", "count": 7}"#;
    let result: Result<ApiEnvelope<Payload>, _> = serde_json::from_str(json);
    assert!(result.is_err());
}
