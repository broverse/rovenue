use std::sync::Arc;

use crate::config::Config;
use crate::error::RovenueResult;
use crate::version::SDK_VERSION;

pub struct RovenueCore {
    config: Arc<Config>,
}

impl RovenueCore {
    pub fn new(config: Config) -> RovenueResult<Self> {
        Ok(Self { config: Arc::new(config) })
    }

    pub fn get_version(&self) -> String {
        SDK_VERSION.to_string()
    }

    pub fn config(&self) -> Arc<Config> {
        Arc::clone(&self.config)
    }
}
