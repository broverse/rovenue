use std::sync::Arc;
use std::time::Duration;

use rovenue::api::RovenueCore;
use rovenue::cache::CacheStore;
use rovenue::config::Config;
use rovenue::placements::PlacementsClient;
use rovenue::transport::http_client::HttpClient;

fn http_client(url: &str) -> HttpClient {
    HttpClient::new(url.to_string(), "pk_test".into())
        .with_max_attempts(1)
        .with_request_timeout(Duration::from_millis(500))
}

fn store() -> Arc<CacheStore> {
    Arc::new(CacheStore::open_in_memory().unwrap())
}

const DIRECT_PAYWALL_BODY: &str = include_str!("fixtures/placement_paywall_response.json");
const NONE_BODY: &str = include_str!("fixtures/placement_none_response.json");
const EXPERIMENT_BODY: &str = include_str!("fixtures/placement_experiment_response.json");

// Subscriber/seed pair lifted verbatim from
// packages/shared/src/experiments/bucketing-vectors.json case 1: bucket 7655
// against weights a:.34/b:.33/c:.33 lands on "c" — verified by the
// cross-language bucketing contract test in src/placements/bucketing.rs.
const EXPERIMENT_SUBSCRIBER_ID: &str = "ckvt3m8qc0000356mekq0v1x2";

#[test]
fn get_paywall_maps_direct_paywall_to_ffi() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/placements/onboarding")
        .with_status(200)
        .with_body(DIRECT_PAYWALL_BODY)
        .match_header("authorization", "Bearer pk_test")
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    let paywall = client
        .get_paywall("onboarding", None, "sub_1")
        .unwrap()
        .expect("paywall resolved");
    m.assert();

    assert_eq!(paywall.placement_identifier, "onboarding");
    assert_eq!(paywall.placement_revision, 3);
    assert_eq!(
        paywall.paywall_identifier.as_deref(),
        Some("default_paywall")
    );
    assert_eq!(paywall.paywall_name.as_deref(), Some("Default"));
    assert_eq!(paywall.config_format_version, 1);
    assert_eq!(paywall.remote_config_locale.as_deref(), Some("en"));
    assert_eq!(
        paywall.remote_config_json.as_deref(),
        Some(r#"{"title":"Go Pro"}"#)
    );
    // Fixture predates builderConfig — absent field must decode as None.
    assert_eq!(paywall.builder_config_json, None);

    let offering = paywall.offering.expect("offering present");
    assert_eq!(offering.identifier, "default");
    assert!(offering.is_default);
    assert_eq!(offering.packages[0].package_identifier, "$rov_monthly");
    assert_eq!(
        offering.packages[0].apple_product_id.as_deref(),
        Some("com.x.pro.monthly")
    );

    // Direct (non-experiment) resolution still stamps attribution, without a
    // variant/experiment key.
    let ctx = paywall
        .presented_context
        .expect("presented context present");
    assert_eq!(ctx.placement_id, "onboarding");
    assert_eq!(ctx.paywall_id, "pw_1");
    assert_eq!(ctx.variant_id, None);
    assert_eq!(ctx.experiment_key, None);
    assert_eq!(ctx.revision, 3);
}

#[test]
fn get_paywall_sends_locale_query_param() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/placements/onboarding?locale=tr")
        .with_status(200)
        .with_body(DIRECT_PAYWALL_BODY)
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    client
        .get_paywall("onboarding", Some("tr"), "sub_1")
        .unwrap();
    m.assert();
}

#[test]
fn get_paywall_returns_none_when_resolved_to_nothing() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/placements/onboarding")
        .with_status(200)
        .with_body(NONE_BODY)
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    let result = client.get_paywall("onboarding", None, "sub_1").unwrap();
    m.assert();

    assert!(
        result.is_none(),
        "target:none / no match must resolve to None, not an error"
    );
}

#[test]
#[serial_test::serial]
fn get_paywall_experiment_draws_deterministic_variant_and_fires_expose() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/placements/onboarding")
        .with_status(200)
        .with_body(EXPERIMENT_BODY)
        .create();
    let expose = server
        .mock("POST", "/v1/experiments/exp_1/expose")
        .match_body(mockito::Matcher::PartialJson(serde_json::json!({
            "variantId": "c",
            "subscriberId": EXPERIMENT_SUBSCRIBER_ID,
            "placementId": "onboarding",
        })))
        .with_status(202)
        .with_body("")
        .expect(1)
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    let paywall = client
        .get_paywall("onboarding", None, EXPERIMENT_SUBSCRIBER_ID)
        .unwrap()
        .expect("experiment resolved to a paywall");
    m.assert();

    // Deterministic draw: bucket 7655 for this subscriber/seed selects "c".
    assert_eq!(paywall.paywall_identifier.as_deref(), Some("paywall_c"));
    let ctx = paywall
        .presented_context
        .expect("presented context present");
    assert_eq!(ctx.variant_id.as_deref(), Some("c"));
    assert_eq!(ctx.experiment_key.as_deref(), Some("onboarding-price-test"));
    assert_eq!(ctx.placement_id, "onboarding");
    assert_eq!(ctx.paywall_id, "pw_c");
    assert_eq!(ctx.revision, 5);

    // Let the fire-and-forget expose POST land.
    std::thread::sleep(Duration::from_millis(300));
    expose.assert();
}

/// On a successful fetch the response is persisted; a subsequent fetch that
/// fails with a network-class error (connection refused) re-resolves from
/// the cached payload — including re-drawing the experiment bucket.
#[test]
fn serves_cache_on_network_failure() {
    let cache = store();

    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/placements/onboarding")
        .with_status(200)
        .with_body(EXPERIMENT_BODY)
        .create();
    let online = PlacementsClient::new(Arc::new(http_client(&server.url())), Arc::clone(&cache));
    let first = online
        .get_paywall("onboarding", None, EXPERIMENT_SUBSCRIBER_ID)
        .unwrap()
        .expect("first resolves");
    m.assert();
    assert_eq!(first.paywall_identifier.as_deref(), Some("paywall_c"));

    let offline = PlacementsClient::new(
        Arc::new(http_client("http://127.0.0.1:1")),
        Arc::clone(&cache),
    );
    let cached = offline
        .get_paywall("onboarding", None, EXPERIMENT_SUBSCRIBER_ID)
        .unwrap()
        .expect("served from cache");
    assert_eq!(cached.paywall_identifier.as_deref(), Some("paywall_c"));
    assert_eq!(
        cached.presented_context.unwrap().variant_id.as_deref(),
        Some("c")
    );
}

/// builderConfig (Phase B/C) rides CorePaywall as a raw JSON string — both
/// on a live fetch and when re-resolved from the offline cache.
#[test]
fn builder_config_round_trips_live_and_from_cache() {
    const BUILDER_BODY: &str = include_str!("fixtures/placement_paywall_builder_response.json");
    let cache = store();

    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/placements/onboarding")
        .with_status(200)
        .with_body(BUILDER_BODY)
        .create();
    let online = PlacementsClient::new(Arc::new(http_client(&server.url())), Arc::clone(&cache));
    let live = online
        .get_paywall("onboarding", None, "sub_1")
        .unwrap()
        .expect("resolves");
    m.assert();

    let json = live.builder_config_json.expect("builder config present");
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
    assert_eq!(parsed["formatVersion"], 2);
    assert_eq!(parsed["root"]["children"][0]["key"], "t");
    assert_eq!(live.config_format_version, 2);

    let offline = PlacementsClient::new(
        Arc::new(http_client("http://127.0.0.1:1")),
        Arc::clone(&cache),
    );
    let cached = offline
        .get_paywall("onboarding", None, "sub_1")
        .unwrap()
        .expect("served from cache");
    assert_eq!(cached.builder_config_json, Some(json));
}

#[test]
fn propagates_error_when_no_cache() {
    let offline = PlacementsClient::new(Arc::new(http_client("http://127.0.0.1:1")), store());
    let res = offline.get_paywall("onboarding", None, "sub_1");
    assert!(res.is_err(), "expected error when offline with empty cache");
}

// =============================================================
// Bundled fallback file (spec D1) — resolve ladder: network -> disk cache ->
// fallback map -> original error. Cache always beats fallback; the fallback
// is only ever consulted on the same connectivity-class branch the disk
// cache already sits on (auth/server errors propagate unchanged, same as
// today). See src/placements/fallback.rs for the file-parsing tests
// (format-version rejection, partial-file skip behavior).
// =============================================================

/// Minimal PlacementsResponse-shaped JSON — a direct (non-experiment)
/// paywall assignment, distinguishable from the live/cache fixtures by its
/// own identifiers so tests can assert exactly which layer served a result.
const FALLBACK_DIRECT_ENTRY: &str = r#"{"placement":{"identifier":"onboarding","revision":9},"paywall":{"id":"pw_fallback","identifier":"fallback_paywall","name":"Fallback","configFormatVersion":1,"remoteConfig":null,"offering":null},"experiment":null}"#;

#[test]
fn fallback_serves_paywall_when_network_and_cache_both_miss() {
    let offline = PlacementsClient::new(Arc::new(http_client("http://127.0.0.1:1")), store());
    offline.set_fallback(std::collections::HashMap::from([(
        "onboarding".to_string(),
        FALLBACK_DIRECT_ENTRY.to_string(),
    )]));

    let paywall = offline
        .get_paywall("onboarding", None, "sub_1")
        .unwrap()
        .expect("served from the bundled fallback map");

    assert_eq!(
        paywall.paywall_identifier.as_deref(),
        Some("fallback_paywall")
    );
    assert!(
        paywall.served_from_fallback,
        "fallback-branch result must set served_from_fallback"
    );
}

#[test]
fn network_beats_fallback() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/placements/onboarding")
        .with_status(200)
        .with_body(DIRECT_PAYWALL_BODY)
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    client.set_fallback(std::collections::HashMap::from([(
        "onboarding".to_string(),
        FALLBACK_DIRECT_ENTRY.to_string(),
    )]));

    let paywall = client
        .get_paywall("onboarding", None, "sub_1")
        .unwrap()
        .expect("resolved");
    m.assert();

    assert_eq!(
        paywall.paywall_identifier.as_deref(),
        Some("default_paywall"),
        "a successful live fetch must win over a loaded fallback entry"
    );
    assert!(!paywall.served_from_fallback);
}

#[test]
fn cache_beats_fallback() {
    let cache = store();

    // Prime the disk cache with a live fetch.
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/placements/onboarding")
        .with_status(200)
        .with_body(DIRECT_PAYWALL_BODY)
        .create();
    let online = PlacementsClient::new(Arc::new(http_client(&server.url())), Arc::clone(&cache));
    online.get_paywall("onboarding", None, "sub_1").unwrap();
    m.assert();

    // A second client, sharing the now-primed cache, offline, with a
    // fallback entry ALSO loaded for the same identifier.
    let offline = PlacementsClient::new(
        Arc::new(http_client("http://127.0.0.1:1")),
        Arc::clone(&cache),
    );
    offline.set_fallback(std::collections::HashMap::from([(
        "onboarding".to_string(),
        FALLBACK_DIRECT_ENTRY.to_string(),
    )]));

    let paywall = offline
        .get_paywall("onboarding", None, "sub_1")
        .unwrap()
        .expect("resolved from cache");

    assert_eq!(
        paywall.paywall_identifier.as_deref(),
        Some("default_paywall"),
        "the disk cache must win over a loaded fallback entry"
    );
    assert!(!paywall.served_from_fallback);
}

#[test]
fn auth_error_does_not_consult_fallback() {
    let mut server = mockito::Server::new();
    let m = server
        .mock("GET", "/v1/placements/onboarding")
        .with_status(401)
        .with_body(r#"{"error":{"code":"INVALID_API_KEY","message":"bad key"}}"#)
        .create();

    let client = PlacementsClient::new(Arc::new(http_client(&server.url())), store());
    client.set_fallback(std::collections::HashMap::from([(
        "onboarding".to_string(),
        FALLBACK_DIRECT_ENTRY.to_string(),
    )]));

    let err = client
        .get_paywall("onboarding", None, "sub_1")
        .expect_err("auth errors must propagate, never fall back");
    m.assert();

    assert_eq!(err.kind, rovenue::error::ErrorKind::InvalidApiKey);
}

#[test]
fn fallback_experiment_draws_the_same_deterministic_variant_as_live() {
    // Reuse the live experiment fixture's inner payload verbatim as the
    // bundled fallback entry — same weights/variant order — so a
    // deterministic draw for the same subscriber must select the same
    // variant offline as it did live.
    let inner: serde_json::Value = serde_json::from_str(EXPERIMENT_BODY).unwrap();
    let fallback_entry = inner["data"].to_string();

    let offline = PlacementsClient::new(Arc::new(http_client("http://127.0.0.1:1")), store());
    offline.set_fallback(std::collections::HashMap::from([(
        "onboarding".to_string(),
        fallback_entry,
    )]));

    let paywall = offline
        .get_paywall("onboarding", None, EXPERIMENT_SUBSCRIBER_ID)
        .unwrap()
        .expect("experiment resolved from fallback");

    // Same bucket 7655 / weights a:.34 b:.33 c:.33 as
    // get_paywall_experiment_draws_deterministic_variant_and_fires_expose.
    assert_eq!(paywall.paywall_identifier.as_deref(), Some("paywall_c"));
    assert_eq!(
        paywall.presented_context.unwrap().variant_id.as_deref(),
        Some("c")
    );
    assert!(paywall.served_from_fallback);
}

// =============================================================
// RovenueCore::set_fallback_placements — the FFI-facing entry point that
// parses a spec D1 file once and loads it into the PlacementsClient above.
// =============================================================

#[test]
fn core_set_fallback_placements_rejects_wrong_format_version() {
    let core = test_core_with_base_url("http://127.0.0.1:1");
    let json = r#"{"formatVersion":2,"generatedAt":1,"projectId":"p","placements":{}}"#;
    let err = core
        .set_fallback_placements(json.to_string())
        .expect_err("wrong formatVersion must be a distinct, loud error");
    assert_eq!(err.kind, rovenue::error::ErrorKind::InvalidArgument);
    assert!(err.message.contains("formatVersion"));
}

#[test]
fn core_set_fallback_placements_loads_partial_file_and_powers_get_paywall() {
    let core = test_core_with_base_url("http://127.0.0.1:1");
    let json = format!(
        r#"{{"formatVersion":1,"generatedAt":1,"projectId":"p","placements":{{"onboarding":{FALLBACK_DIRECT_ENTRY},"bad":{{"placement":"not-an-object"}}}}}}"#
    );
    let loaded = core
        .set_fallback_placements(json)
        .expect("partially-valid file still loads its good entries");
    assert_eq!(loaded, 1, "the malformed \"bad\" entry must be skipped");

    let paywall = core
        .get_paywall("onboarding".into(), None)
        .unwrap()
        .expect("served from the fallback set just loaded");
    assert_eq!(
        paywall.paywall_identifier.as_deref(),
        Some("fallback_paywall")
    );
    assert!(paywall.served_from_fallback);
}

// =============================================================
// RovenueCore facade: get_paywall stamps presented_context into core state,
// and a subsequent successful receipt POST carries + clears it.
// =============================================================

fn test_core_with_base_url(base_url: &str) -> RovenueCore {
    let config = Config::new("pk_test".into(), base_url.to_string()).unwrap();
    RovenueCore::new_for_test(config).unwrap()
}

#[test]
fn core_get_paywall_round_trips_and_stamps_receipt_presented_context() {
    let mut server = mockito::Server::new();
    let _placement = server
        .mock("GET", "/v1/placements/onboarding")
        .with_status(200)
        .with_body(DIRECT_PAYWALL_BODY)
        .create();

    let core = test_core_with_base_url(&server.url());
    let paywall = core
        .get_paywall("onboarding".into(), None)
        .unwrap()
        .expect("paywall resolved");
    assert_eq!(
        paywall.paywall_identifier.as_deref(),
        Some("default_paywall")
    );

    const RECEIPT_OK_BODY: &str = r#"{"data":{"subscriber":{"id":"sub_1","appUserId":"anon_1"},
        "virtualCurrencyBalances":{},"access":{}}}"#;

    // First POST carries the attribution stamped by get_paywall().
    let receipt_with_ctx = server
        .mock("POST", "/v1/receipts/apple")
        .match_body(mockito::Matcher::PartialJson(serde_json::json!({
            "receipt": "<jws>",
            "presentedContext": {
                "placementId": "onboarding",
                "paywallId": "pw_1",
            }
        })))
        .with_status(200)
        .with_body(RECEIPT_OK_BODY)
        .expect(1)
        .create();

    core.post_apple_receipt("<jws>".into(), "pro_monthly".into(), None)
        .expect("receipt post ok");
    receipt_with_ctx.assert();

    // Second POST must NOT resend the (now-cleared) attribution — match the
    // exact body (receipt/appUserId/productId only; ReceiptBody's derived
    // field order puts `presentedContext` last and it's skipped when None)
    // so any stray attribution field would fail the match.
    let wire_id = core.current_user().rovenue_id;
    let exact_body_no_ctx =
        format!(r#"{{"receipt":"<jws2>","appUserId":"{wire_id}","productId":"pro_monthly"}}"#);
    let receipt_without_ctx = server
        .mock("POST", "/v1/receipts/apple")
        .match_body(mockito::Matcher::Exact(exact_body_no_ctx))
        .with_status(200)
        .with_body(RECEIPT_OK_BODY)
        .expect(1)
        .create();

    core.post_apple_receipt("<jws2>".into(), "pro_monthly".into(), None)
        .expect("second receipt post ok");
    receipt_without_ctx.assert();
}
