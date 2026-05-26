use rovenue::cache::credits::{CreditBalanceRepo, CreditBalanceRow};
use rovenue::cache::CacheStore;

#[test]
fn empty_balance_is_none() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = CreditBalanceRepo::new(&store);
    assert!(repo.get("user_42").unwrap().is_none());
}

#[test]
fn upsert_and_read() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = CreditBalanceRepo::new(&store);
    repo.upsert(&CreditBalanceRow {
        user_scope: "user_42".into(),
        balance: 100,
        updated_at_ms: 1,
    })
    .unwrap();
    let got = repo.get("user_42").unwrap().unwrap();
    assert_eq!(got.balance, 100);

    repo.upsert(&CreditBalanceRow {
        user_scope: "user_42".into(),
        balance: 75,
        updated_at_ms: 2,
    })
    .unwrap();
    let got = repo.get("user_42").unwrap().unwrap();
    assert_eq!(got.balance, 75);
    assert_eq!(got.updated_at_ms, 2);
}

#[test]
fn scopes_are_isolated() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = CreditBalanceRepo::new(&store);
    repo.upsert(&CreditBalanceRow { user_scope: "a".into(), balance: 5, updated_at_ms: 1 }).unwrap();
    repo.upsert(&CreditBalanceRow { user_scope: "b".into(), balance: 9, updated_at_ms: 1 }).unwrap();
    assert_eq!(repo.get("a").unwrap().unwrap().balance, 5);
    assert_eq!(repo.get("b").unwrap().unwrap().balance, 9);
}
