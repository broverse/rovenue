pub mod bucketing;
pub mod client;
pub mod fallback;
pub mod types;

pub use bucketing::{assign_bucket, select_variant_index, BUCKET_COUNT};
pub use client::PlacementsClient;
pub use fallback::parse_fallback_file;
pub use types::{CorePaywall, CorePresentedContext};
