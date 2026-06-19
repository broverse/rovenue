// Task A4: Automatic exposure tracking tests.
//
// Verifies:
//   1. First experiment(key) read fires exactly one POST /expose.
//   2. Repeated reads dedup (same experiment+variant → no second POST).
//   3. experiments_all() fires zero POSTs.

use rovenue::api::RovenueCore;
use rovenue::config::Config;

// Remote-config response seeding one experiment: key "paywall", id "e1", variant "v1".
const CONFIG_BODY: &str = r#"{"data":{
    "flags":{},
    "experiments":{
        "paywall":{
            "experimentId":"e1",
            "key":"paywall",
            "variantId":"v1",
            "variantName":"Treatment",
            "value":{}
        }
    }
}}"#;

fn seed_remote_config(server: &mut mockito::Server) {
    server
        .mock("GET", "/v1/config")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(CONFIG_BODY)
        .create();
}

fn test_core_with_base_url(base_url: &str) -> RovenueCore {
    let config = Config::new("pk_test".into(), base_url.to_string()).unwrap();
    RovenueCore::new_for_test(config).unwrap()
}

#[test]
#[serial_test::serial]
fn experiment_read_fires_one_exposure_then_dedups() {
    let mut server = mockito::Server::new();
    seed_remote_config(&mut server);

    let expose = server
        .mock("POST", "/v1/experiments/e1/expose")
        .match_body(mockito::Matcher::PartialJson(
            serde_json::json!({ "variantId": "v1" }),
        ))
        .with_status(202)
        .with_body("")
        .expect(1) // exactly once despite multiple reads
        .create();

    let core = test_core_with_base_url(&server.url());
    core.refresh_remote_config().unwrap();

    // Multiple reads → still only one exposure POST fired.
    let _ = core.experiment("paywall".into());
    let _ = core.experiment("paywall".into());
    let _ = core.experiment("paywall".into());

    // Let the async POST land.
    std::thread::sleep(std::time::Duration::from_millis(300));

    expose.assert();
}

#[test]
#[serial_test::serial]
fn experiments_all_does_not_fire_exposure() {
    let mut server = mockito::Server::new();
    seed_remote_config(&mut server);

    let expose = server
        .mock("POST", "/v1/experiments/e1/expose")
        .expect(0)
        .create();

    let core = test_core_with_base_url(&server.url());
    core.refresh_remote_config().unwrap();

    let _ = core.experiments_all();

    std::thread::sleep(std::time::Duration::from_millis(100));

    expose.assert();
}
