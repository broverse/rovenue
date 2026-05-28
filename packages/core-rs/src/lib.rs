// UniFFI-generated scaffolding triggers this lint; suppress it crate-wide.
#![allow(clippy::empty_line_after_doc_comments)]

pub mod api;
pub mod cache;
pub mod config;
pub mod credits;
pub mod entitlements;
pub mod error;
pub mod events;
pub mod identity;
pub mod observer;
pub mod polling;
pub mod receipts;
pub mod time;
pub mod transport;
pub mod version;

pub use api::RovenueCore;
pub use config::Config;
pub use entitlements::Entitlement;
pub use error::{RovenueError, RovenueResult};
pub use events::{EventEnvelope, IdentityContext, EVENT_WIRE_VERSION};
pub use identity::User;
pub use observer::{ChangeEvent, Observer};
pub use receipts::ReceiptResult;
pub use version::SDK_VERSION;

pub fn sdk_version() -> String {
    SDK_VERSION.to_string()
}

uniffi::include_scaffolding!("librovenue");
