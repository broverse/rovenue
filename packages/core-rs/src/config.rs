use crate::error::{RovenueError, RovenueResult};

#[derive(Debug, Clone)]
pub struct Config {
    pub api_key: String,
    pub base_url: String,
    pub debug: bool,
}

impl Config {
    pub fn new(api_key: String, base_url: String) -> RovenueResult<Self> {
        if api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
            return Err(RovenueError::Internal(format!(
                "base_url must be http(s)://, got {base_url}"
            )));
        }
        Ok(Self { api_key, base_url, debug: false })
    }
}
