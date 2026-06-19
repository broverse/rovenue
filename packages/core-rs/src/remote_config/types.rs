use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// FFI-facing experiment assignment for the current subscriber.
///
/// `value_json` is the variant payload serialized as a JSON string — UniFFI
/// can't carry arbitrary JSON, so façades parse it on their side (or read it
/// as a plain string for primitive variant values).
#[derive(Debug, Clone, PartialEq)]
pub struct ExperimentAssignment {
    pub experiment_id: String,
    pub key: String,
    pub variant_id: String,
    pub variant_name: String,
    pub value_json: String,
}

/// `data` payload of `GET /v1/config`:
/// `{ flags: { key: value }, experiments: { key: {…} } }`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct ConfigResponse {
    #[serde(default)]
    pub flags: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub experiments: HashMap<String, ExperimentWire>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ExperimentWire {
    #[serde(rename = "experimentId")]
    pub experiment_id: String,
    pub key: String,
    #[serde(rename = "variantId")]
    pub variant_id: String,
    #[serde(rename = "variantName")]
    pub variant_name: String,
    #[serde(default)]
    pub value: serde_json::Value,
}
