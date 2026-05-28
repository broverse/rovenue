pub mod account_token;
pub mod buffer;
pub mod dispatcher;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionEventKind {
    Open,
    Background,
    Close,
}

impl SessionEventKind {
    pub fn as_wire(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Background => "background",
            Self::Close => "close",
        }
    }
}

pub use account_token::AccountTokenStore;
pub use buffer::SessionBuffer;
pub use dispatcher::SessionDispatcher;
