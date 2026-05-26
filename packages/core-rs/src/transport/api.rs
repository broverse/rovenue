use serde::Deserialize;

/// Every Rovenue server response is wrapped `{ "data": <…> }` (success)
/// or `{ "error": { "code": "…", "message": "…" } }` (failure mapped via
/// HTTP status by HttpClient).
#[derive(Debug, Deserialize)]
pub struct ApiEnvelope<T> {
    pub data: T,
}
