use serde::Deserialize;

/// Every Rovenue server response is wrapped `{ "data": <…> }` (success)
/// or `{ "error": { "code": "…", "message": "…" } }` (failure mapped via
/// HTTP status by HttpClient).
#[derive(Debug, Deserialize)]
pub struct ApiEnvelope<T> {
    pub data: T,
}

/// Top-level error envelope: `{ "error": { "code": "…", "message": "…" } }`.
#[derive(Debug, Deserialize)]
pub struct ApiErrorBody {
    pub error: ApiError,
}

/// Backend error payload carried inside `ApiErrorBody`.
#[derive(Debug, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}
