use crate::error::{RovenueError, RovenueResult};

/// Canonical hosted endpoint used when the caller does not supply a base URL.
/// MUST stay in sync with the `base_url` default literal in `librovenue.udl`.
pub const DEFAULT_BASE_URL: &str = "https://api.rovenue.io";

#[derive(Debug, Clone)]
pub struct Config {
    pub api_key: String,
    pub base_url: String,
    pub debug: bool,
    /// Host app's user-facing version string (CFBundleShortVersionString on iOS,
    /// PackageInfo.versionName on Android). Forwarded into session-event
    /// telemetry payloads. `None` is serialized as `""` to preserve the
    /// pre-0.7 wire format.
    pub app_version: Option<String>,
    /// Runtime platform the SDK is running on (`ios` / `android` / `web`),
    /// supplied by the native façade. Sent as the `X-Rovenue-Platform` header
    /// so the backend can record it as the subscriber's first-install platform
    /// on create. `None` omits the header entirely.
    pub platform: Option<String>,
    /// Remote Config environment (`prod` / `staging` / `development`). Sent as
    /// the `X-Rovenue-Env` header on the `/v1/config` request so the backend
    /// serves the matching flag/experiment set. `None` omits the header, which
    /// the backend treats as `prod`.
    pub environment: Option<String>,
}

impl Config {
    pub fn new(api_key: String, base_url: String) -> RovenueResult<Self> {
        if api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        Ok(Self {
            api_key,
            base_url: resolve_base_url(&base_url)?,
            debug: false,
            app_version: None,
            platform: None,
            environment: None,
        })
    }

    /// Builder-style setter for the host app version.
    pub fn with_app_version(mut self, app_version: Option<String>) -> Self {
        self.app_version = app_version;
        self
    }

    /// Builder-style setter for the runtime platform.
    pub fn with_platform(mut self, platform: Option<String>) -> Self {
        self.platform = platform;
        self
    }

    /// Builder-style setter for the Remote Config environment.
    pub fn with_environment(mut self, environment: Option<String>) -> Self {
        self.environment = environment;
        self
    }

    /// Normalize + validate a `Config` built directly from the UniFFI
    /// dictionary. The FFI path constructs the struct field-by-field and
    /// bypasses `new`, so this is where the base-URL rules get enforced over
    /// the FFI boundary. Empty `base_url` falls back to the hosted default.
    pub fn normalized(mut self) -> RovenueResult<Self> {
        self.base_url = resolve_base_url(&self.base_url)?;
        Ok(self)
    }
}

/// Resolve a caller-supplied base URL:
/// - blank (after trim) → [`DEFAULT_BASE_URL`]
/// - `https://…` accepted
/// - `http://…` accepted ONLY for localhost / 127.0.0.1 / [::1] (local dev)
/// - anything else → [`RovenueError::InvalidArgument`]
pub fn resolve_base_url(input: &str) -> RovenueResult<String> {
    let trimmed = input.trim();
    let url = if trimmed.is_empty() { DEFAULT_BASE_URL } else { trimmed };

    if let Some(rest) = url.strip_prefix("https://") {
        if rest.is_empty() {
            return Err(RovenueError::InvalidArgument);
        }
        return Ok(url.to_string());
    }

    if let Some(host) = url.strip_prefix("http://") {
        let is_local = host == "localhost"
            || host.starts_with("localhost:")
            || host.starts_with("localhost/")
            || host == "127.0.0.1"
            || host.starts_with("127.0.0.1:")
            || host.starts_with("127.0.0.1/")
            || host.starts_with("[::1]");
        if is_local {
            return Ok(url.to_string());
        }
        return Err(RovenueError::InvalidArgument);
    }

    Err(RovenueError::InvalidArgument)
}
