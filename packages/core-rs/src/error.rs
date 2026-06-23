/// Normalized error category — the stable discriminant callers switch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    // network / transport
    NetworkUnavailable,
    Timeout,
    RateLimited,
    ServerError,
    // auth / request
    InvalidApiKey,
    Forbidden,
    NotFound,
    InvalidRequest,
    Conflict,
    InvalidArgument,
    // domain
    InsufficientCredits,
    FunnelTokenNotFound,
    FunnelTokenExpired,
    FunnelTokenAlreadyClaimed,
    // store
    PurchaseCanceled,
    ProductNotAvailable,
    AlreadyOwned,
    PaymentDeclined,
    StoreServiceUnavailable,
    Ineligible,
    ReceiptInvalid,
    StoreProblem,
    // other
    Storage,
    Internal,
}

impl ErrorKind {
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            ErrorKind::NetworkUnavailable
                | ErrorKind::Timeout
                | ErrorKind::RateLimited
                | ErrorKind::ServerError
                | ErrorKind::StoreServiceUnavailable
        )
    }

    /// Default English message used when the backend supplies none.
    pub fn default_message(&self) -> &'static str {
        match self {
            ErrorKind::NetworkUnavailable => "network unavailable",
            ErrorKind::Timeout => "request timed out",
            ErrorKind::RateLimited => "rate limited",
            ErrorKind::ServerError => "server error",
            ErrorKind::InvalidApiKey => "invalid api key",
            ErrorKind::Forbidden => "forbidden",
            ErrorKind::NotFound => "not found",
            ErrorKind::InvalidRequest => "invalid request",
            ErrorKind::Conflict => "conflict",
            ErrorKind::InvalidArgument => "invalid argument",
            ErrorKind::InsufficientCredits => "insufficient credits",
            ErrorKind::FunnelTokenNotFound => "funnel token not found",
            ErrorKind::FunnelTokenExpired => "funnel token expired",
            ErrorKind::FunnelTokenAlreadyClaimed => "funnel token already claimed",
            ErrorKind::PurchaseCanceled => "purchase canceled",
            ErrorKind::ProductNotAvailable => "product not available",
            ErrorKind::AlreadyOwned => "already owned",
            ErrorKind::PaymentDeclined => "payment declined",
            ErrorKind::StoreServiceUnavailable => "store service unavailable",
            ErrorKind::Ineligible => "ineligible",
            ErrorKind::ReceiptInvalid => "receipt invalid",
            ErrorKind::StoreProblem => "store problem",
            ErrorKind::Storage => "storage error",
            ErrorKind::Internal => "internal error",
        }
    }
}

/// The single error type the core produces and exports across FFI.
#[derive(Debug, Clone)]
pub struct RovenueError {
    pub kind: ErrorKind,
    pub message: String,
    pub server_code: Option<String>,
    pub http_status: Option<u16>,
    pub retryable: bool,
}

impl RovenueError {
    /// Construct from a kind alone (network/store/internal paths).
    pub fn kind(kind: ErrorKind) -> Self {
        Self {
            kind,
            message: kind.default_message().to_string(),
            server_code: None,
            http_status: None,
            retryable: kind.is_retryable(),
        }
    }
    /// Construct from an HTTP error, preserving the backend code/message.
    pub fn http(
        kind: ErrorKind,
        status: u16,
        server_code: Option<String>,
        message: String,
    ) -> Self {
        let message = if message.is_empty() {
            kind.default_message().to_string()
        } else {
            message
        };
        Self {
            kind,
            message,
            server_code,
            http_status: Some(status),
            retryable: kind.is_retryable(),
        }
    }
}

impl RovenueError {
    // ── Shim constructors preserving old call-site API ──────────────────────
    // PascalCase names are intentional: they mirror the old fieldless-variant API
    // so hundreds of call sites compile unchanged while Task 2+ migrates them
    // incrementally. `#[allow(non_snake_case)]` is scoped to this impl block only.
    #[allow(non_snake_case)]
    pub fn Internal() -> Self {
        Self::kind(ErrorKind::Internal)
    }
    #[allow(non_snake_case)]
    pub fn NetworkUnavailable() -> Self {
        Self::kind(ErrorKind::NetworkUnavailable)
    }
    #[allow(non_snake_case)]
    pub fn ServerError() -> Self {
        Self::kind(ErrorKind::ServerError)
    }
    #[allow(non_snake_case)]
    pub fn RateLimited() -> Self {
        Self::kind(ErrorKind::RateLimited)
    }
    #[allow(non_snake_case)]
    pub fn InvalidApiKey() -> Self {
        Self::kind(ErrorKind::InvalidApiKey)
    }
    #[allow(non_snake_case)]
    pub fn Timeout() -> Self {
        Self::kind(ErrorKind::Timeout)
    }
    #[allow(non_snake_case)]
    pub fn InsufficientCredits() -> Self {
        Self::kind(ErrorKind::InsufficientCredits)
    }
    #[allow(non_snake_case)]
    pub fn Storage() -> Self {
        Self::kind(ErrorKind::Storage)
    }
    #[allow(non_snake_case)]
    pub fn InvalidArgument() -> Self {
        Self::kind(ErrorKind::InvalidArgument)
    }
    #[allow(non_snake_case)]
    pub fn FunnelTokenNotFound() -> Self {
        Self::kind(ErrorKind::FunnelTokenNotFound)
    }
    #[allow(non_snake_case)]
    pub fn FunnelTokenExpired() -> Self {
        Self::kind(ErrorKind::FunnelTokenExpired)
    }
    #[allow(non_snake_case)]
    pub fn FunnelTokenAlreadyClaimed() -> Self {
        Self::kind(ErrorKind::FunnelTokenAlreadyClaimed)
    }
}

impl std::fmt::Display for RovenueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for RovenueError {}

pub type RovenueResult<T> = std::result::Result<T, RovenueError>;

// ── FFI projection ──────────────────────────────────────────────────────────
//
// uniffi 0.25 (UDL mode) requires the thrown error to be a Rust *enum* whose
// variant carries the fields declared in `[Error] interface RovenueErrorFfi`.
// We keep the ergonomic `RovenueError` struct for all internal Rust use (field
// access `e.kind`, `e.http_status`, …) and project it onto this single-variant
// rich enum at the FFI boundary. uniffi's generated scaffolding appends
// `.map_err(Into::into)` to every `[Throws]` method in UDL mode, so the
// `From<RovenueError>` impl below is the only wiring needed — the `RovenueCore`
// methods continue to return `RovenueResult<T>` unchanged.
//
// The generated Swift `RovenueErrorFfi` / Kotlin `RovenueErrorFfiException`
// surface the `.Generic` case carrying kind/message/serverCode/httpStatus/
// retryable, which the façade tasks (5–7) consume.
#[derive(Debug, Clone)]
pub enum RovenueErrorFfi {
    Generic {
        kind: ErrorKind,
        /// Renamed from `message` to `detail` to avoid collision with
        /// Kotlin `Exception.message` / Swift `LocalizedError.errorDescription`
        /// in the uniffi-generated façade types.
        detail: String,
        server_code: Option<String>,
        http_status: Option<u16>,
        retryable: bool,
    },
}

impl From<RovenueError> for RovenueErrorFfi {
    fn from(e: RovenueError) -> Self {
        RovenueErrorFfi::Generic {
            kind: e.kind,
            detail: e.message,
            server_code: e.server_code,
            http_status: e.http_status,
            retryable: e.retryable,
        }
    }
}

impl std::fmt::Display for RovenueErrorFfi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let RovenueErrorFfi::Generic { detail, .. } = self;
        write!(f, "{detail}")
    }
}

impl std::error::Error for RovenueErrorFfi {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_kinds_are_classified() {
        for k in [
            ErrorKind::NetworkUnavailable,
            ErrorKind::Timeout,
            ErrorKind::RateLimited,
            ErrorKind::ServerError,
            ErrorKind::StoreServiceUnavailable,
        ] {
            assert!(k.is_retryable(), "{k:?} should be retryable");
        }
        for k in [
            ErrorKind::InvalidApiKey,
            ErrorKind::Forbidden,
            ErrorKind::NotFound,
            ErrorKind::InvalidRequest,
            ErrorKind::InsufficientCredits,
            ErrorKind::Internal,
        ] {
            assert!(!k.is_retryable(), "{k:?} should NOT be retryable");
        }
    }

    #[test]
    fn http_constructor_carries_fields() {
        let e = RovenueError::http(
            ErrorKind::Forbidden,
            403,
            Some("FORBIDDEN".into()),
            "no access".into(),
        );
        assert_eq!(e.kind, ErrorKind::Forbidden);
        assert_eq!(e.http_status, Some(403));
        assert_eq!(e.server_code.as_deref(), Some("FORBIDDEN"));
        assert_eq!(e.message, "no access");
        assert!(!e.retryable);
    }

    #[test]
    fn kind_constructor_uses_default_message_and_no_http() {
        let e = RovenueError::kind(ErrorKind::Timeout);
        assert_eq!(e.kind, ErrorKind::Timeout);
        assert_eq!(e.http_status, None);
        assert_eq!(e.server_code, None);
        assert!(e.retryable);
        assert!(!e.message.is_empty());
    }
}
