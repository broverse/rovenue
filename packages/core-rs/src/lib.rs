pub mod api;
pub mod config;
pub mod error;
pub mod version;

pub use api::RovenueCore;
pub use config::Config;
pub use error::{RovenueError, RovenueResult};
pub use version::SDK_VERSION;

pub fn sdk_version() -> String {
    SDK_VERSION.to_string()
}

uniffi::include_scaffolding!("librovenue");
