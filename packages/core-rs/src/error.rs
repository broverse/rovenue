use thiserror::Error;

#[derive(Debug, Error)]
pub enum RovenueError {
    #[error("not configured")]
    NotConfigured,

    #[error("invalid api key")]
    InvalidApiKey,

    #[error("invalid argument")]
    InvalidArgument,

    #[error("server error")]
    ServerError,

    #[error("network unavailable")]
    NetworkUnavailable,

    #[error("timeout")]
    Timeout,

    #[error("rate limited")]
    RateLimited,

    #[error("storage error")]
    Storage,

    #[error("user not found")]
    UserNotFound,

    #[error("insufficient credits")]
    InsufficientCredits,

    #[error("entitlement inactive")]
    EntitlementInactive,

    #[error("duplicate purchase")]
    DuplicatePurchase,

    #[error("receipt invalid")]
    ReceiptInvalid,

    #[error("funnel token not found")]
    FunnelTokenNotFound,

    #[error("funnel token expired")]
    FunnelTokenExpired,

    #[error("funnel token already claimed")]
    FunnelTokenAlreadyClaimed,

    #[error("internal error")]
    Internal,
}

pub type RovenueResult<T> = std::result::Result<T, RovenueError>;
