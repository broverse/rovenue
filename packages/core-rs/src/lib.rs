pub mod api;
pub mod cache;
pub mod config;
pub mod error;
pub mod observer;
pub mod time;
pub mod version;

pub use api::RovenueCore;
pub use config::Config;
pub use error::{RovenueError, RovenueResult};
pub use observer::{ChangeEvent, Observer};
pub use version::SDK_VERSION;

pub fn sdk_version() -> String {
    SDK_VERSION.to_string()
}

uniffi::include_scaffolding!("librovenue");
