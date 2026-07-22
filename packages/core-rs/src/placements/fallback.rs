use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use crate::error::{ErrorKind, RovenueError, RovenueResult};
use crate::logging::{LogLevel, Logger};

use super::types::PlacementsResponse;

/// Spec D1 bundled fallback-file format, produced by the dashboard's
/// `GET /dashboard/projects/:id/paywalls/fallback-export` (commit 792cd94c):
/// `{ formatVersion: 1, generatedAt, projectId, placements: { [identifier]:
/// <PlacementsResponse-shaped data> } }`. `generatedAt`/`projectId` are not
/// validated or used by the core — they exist for humans inspecting the
/// file — so they're captured loosely as `Value` rather than typed fields
/// that could reject a future-compatible file over an unrelated shape drift.
#[derive(Debug, Deserialize)]
struct FallbackFileWire {
    #[serde(rename = "formatVersion")]
    format_version: Value,
    #[serde(default)]
    placements: HashMap<String, Value>,
}

fn invalid_argument(message: String) -> RovenueError {
    RovenueError {
        kind: ErrorKind::InvalidArgument,
        message,
        server_code: None,
        http_status: None,
        retryable: false,
    }
}

/// Parse a spec D1 fallback-placements file into `identifier -> raw
/// PlacementsResponse JSON string`.
///
/// Storage choice: `PlacementsResponse` isn't (and shouldn't become)
/// `Clone` — it recursively contains `PaywallWire`/`ExperimentWire`, and the
/// crate's established convention for "hold a wire payload in memory, decode
/// on demand" is already raw-JSON-string storage (see
/// `PlacementsCacheRepo`/the offline-cache branch in `client.rs`, which
/// re-`serde_json::from_str`s the cached string on every offline resolve).
/// This function follows the same convention rather than requiring
/// `PlacementsResponse: Clone` — one fewer derive to keep in sync across the
/// wire-type tree, and `PlacementsClient::get_paywall` already has the
/// decode-from-string codepath it needs to reuse.
///
/// Fails loudly — a distinct `InvalidArgument` error, not a silent partial
/// result — when the file doesn't parse as JSON at all, or when
/// `formatVersion` isn't the literal integer `1`. An integrator who bundles
/// a stale/mismatched export must see this at `configure`/`setFallbackPlacements`
/// time, not months later when a device finally goes offline.
///
/// An individual `placements` entry that doesn't decode as `PlacementsResponse`
/// is SKIPPED (logged when a logger is attached, never fatal) — a
/// partially-valid file still helps: one bad entry shouldn't sacrifice every
/// other placement's offline coverage.
pub fn parse_fallback_file(
    json: &str,
    logger: Option<&Logger>,
) -> RovenueResult<HashMap<String, String>> {
    let file: FallbackFileWire = serde_json::from_str(json).map_err(|e| {
        invalid_argument(format!("fallback placements file is not valid JSON: {e}"))
    })?;

    if file.format_version.as_i64() != Some(1) {
        return Err(invalid_argument(format!(
            "unsupported fallback placements formatVersion {} (expected 1)",
            file.format_version
        )));
    }

    let mut out = HashMap::with_capacity(file.placements.len());
    for (identifier, raw) in file.placements {
        match serde_json::from_value::<PlacementsResponse>(raw.clone()) {
            Ok(_) => match serde_json::to_string(&raw) {
                Ok(s) => {
                    out.insert(identifier, s);
                }
                Err(_) => {
                    // Value -> String re-encoding failure is not realistically
                    // reachable (raw came from a successful JSON parse), but
                    // treat it the same as a decode failure rather than panic.
                    log_skip(logger, &identifier, "re-serialization failed");
                }
            },
            Err(e) => log_skip(logger, &identifier, &e.to_string()),
        }
    }
    Ok(out)
}

fn log_skip(logger: Option<&Logger>, identifier: &str, reason: &str) {
    if let Some(logger) = logger {
        let identifier = identifier.to_string();
        let reason = reason.to_string();
        logger.log(
            LogLevel::Warn,
            move || format!("fallback placement entry skipped: {identifier}"),
            move || {
                let mut f = HashMap::new();
                f.insert("op".to_string(), "fallback_placements_parse".to_string());
                f.insert("reason".to_string(), reason.clone());
                f
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_ENTRY: &str = r#"{"placement":{"identifier":"onboarding","revision":9},"paywall":{"id":"pw_1","identifier":"fallback_paywall","name":"Fallback","configFormatVersion":1,"remoteConfig":null,"offering":null},"experiment":null}"#;

    #[test]
    fn rejects_non_json() {
        let err = parse_fallback_file("not json", None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidArgument);
    }

    #[test]
    fn rejects_wrong_format_version_with_distinct_message() {
        let json = format!(
            r#"{{"formatVersion":2,"generatedAt":1,"projectId":"p","placements":{{"onboarding":{VALID_ENTRY}}}}}"#
        );
        let err = parse_fallback_file(&json, None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidArgument);
        assert!(
            err.message.contains("formatVersion"),
            "expected a formatVersion-specific message, got: {}",
            err.message
        );
    }

    #[test]
    fn rejects_missing_format_version() {
        let json = r#"{"generatedAt":1,"projectId":"p","placements":{}}"#;
        let err = parse_fallback_file(json, None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidArgument);
    }

    #[test]
    fn loads_all_valid_entries() {
        let json = format!(
            r#"{{"formatVersion":1,"generatedAt":1,"projectId":"p","placements":{{"a":{VALID_ENTRY},"b":{VALID_ENTRY}}}}}"#
        );
        let loaded = parse_fallback_file(&json, None).unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(loaded.contains_key("a"));
        assert!(loaded.contains_key("b"));
    }

    #[test]
    fn partially_valid_file_loads_n_minus_1_and_skips_bad_entry() {
        let json = format!(
            r#"{{"formatVersion":1,"generatedAt":1,"projectId":"p","placements":{{"good":{VALID_ENTRY},"bad":{{"placement":"not-an-object"}}}}}}"#
        );
        let loaded = parse_fallback_file(&json, None).unwrap();
        assert_eq!(loaded.len(), 1, "expected only the valid entry to load");
        assert!(loaded.contains_key("good"));
        assert!(!loaded.contains_key("bad"));
    }

    #[test]
    fn loaded_entry_decodes_back_into_placements_response() {
        let json = format!(
            r#"{{"formatVersion":1,"generatedAt":1,"projectId":"p","placements":{{"onboarding":{VALID_ENTRY}}}}}"#
        );
        let loaded = parse_fallback_file(&json, None).unwrap();
        let raw = loaded.get("onboarding").unwrap();
        let decoded: PlacementsResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(decoded.placement.unwrap().identifier, "onboarding");
        assert_eq!(decoded.paywall.unwrap().identifier, "fallback_paywall");
    }
}
