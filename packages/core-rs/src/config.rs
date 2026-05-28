use crate::error::{RovenueError, RovenueResult};

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
}

impl Config {
    pub fn new(api_key: String, base_url: String) -> RovenueResult<Self> {
        if api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
            return Err(RovenueError::Internal);
        }
        Ok(Self {
            api_key,
            base_url,
            debug: false,
            app_version: None,
        })
    }

    /// Builder-style setter for the host app version.
    pub fn with_app_version(mut self, app_version: Option<String>) -> Self {
        self.app_version = app_version;
        self
    }
}
