use thiserror::Error;

#[derive(Debug, Error)]
pub enum RovenueError {
    #[error("not configured")]
    NotConfigured,

    #[error("invalid api key")]
    InvalidApiKey,

    #[error("server error")]
    ServerError,

    #[error("internal error")]
    Internal,
}

pub type RovenueResult<T> = std::result::Result<T, RovenueError>;
