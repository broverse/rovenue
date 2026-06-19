use std::collections::BTreeMap;
use std::sync::Arc;

use rovenue::cache::{CacheStore, ExposureRepo, VirtualCurrencyRepo};

fn open() -> Arc<CacheStore> {
    Arc::new(CacheStore::open_in_memory().unwrap())
}

#[test]
fn vc_repo_replaces_full_balance_set() {
    let store = open();
    let repo = VirtualCurrencyRepo::new(Arc::clone(&store));

    let mut m1 = BTreeMap::new();
    m1.insert("gold".to_string(), 10);
    m1.insert("gems".to_string(), 3);
    repo.upsert_all("scope", &m1, 100).unwrap();
    assert_eq!(repo.get("scope", "gold").unwrap(), Some(10));
    assert_eq!(repo.get_all("scope").unwrap(), m1);

    // server is authoritative: 'gems' dropped, 'gold' updated
    let mut m2 = BTreeMap::new();
    m2.insert("gold".to_string(), 7);
    repo.upsert_all("scope", &m2, 200).unwrap();
    assert_eq!(repo.get_all("scope").unwrap(), m2);
    assert_eq!(repo.get("scope", "gems").unwrap(), None);
}

#[test]
fn exposure_repo_dedups() {
    let store = open();
    let repo = ExposureRepo::new(Arc::clone(&store));

    assert!(!repo.is_exposed("s", "e1", "v1").unwrap());
    repo.mark("s", "e1", "v1", 1).unwrap();
    assert!(repo.is_exposed("s", "e1", "v1").unwrap());
    // a different variant is not yet exposed
    assert!(!repo.is_exposed("s", "e1", "v2").unwrap());
}
