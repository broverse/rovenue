use thiserror::Error;

#[derive(Debug, Error)]
pub enum RovenueError {
    #[error("not configured")]
    NotConfigured,

    #[error("invalid api key")]
    InvalidApiKey,

    #[error("server error: {status} {message}")]
    ServerError { status: u16, message: String },

    #[error("internal: {0}")]
    Internal(String),
}

pub type RovenueResult<T> = std::result::Result<T, RovenueError>;
