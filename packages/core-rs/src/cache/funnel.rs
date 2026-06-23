use crate::cache::CacheStore;
use crate::error::RovenueResult;

/// Persists the per-install id and the once-per-install claim state.
pub struct FunnelRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> FunnelRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    /// Returns the persisted `install_id`, generating + storing it on first call.
    pub fn get_or_create_install_id(&self, now_ms: u64) -> RovenueResult<String> {
        self.store.with_conn(|c| {
            let existing: Option<String> = c
                .query_row(
                    "SELECT install_id FROM funnel_install WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .ok();
            if let Some(id) = existing {
                return Ok(id);
            }
            let id = format!("inst_{}", cuid2::create_id());
            c.execute(
                "INSERT INTO funnel_install (id, install_id, created_at_ms) VALUES (1, ?1, ?2)",
                rusqlite::params![id, now_ms as i64],
            )?;
            Ok(id)
        })
    }

    /// Upserts the claim state for an install (`pending`/`claimed`/`failed`).
    pub fn set_claim_state(
        &self,
        install_id: &str,
        state: &str,
        subscriber_id: Option<&str>,
        now_ms: u64,
    ) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO funnel_claim_state \
                   (install_id, state, subscriber_id, claimed_at_ms, created_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(install_id) DO UPDATE SET \
                   state = excluded.state, \
                   subscriber_id = excluded.subscriber_id, \
                   claimed_at_ms = excluded.claimed_at_ms",
                rusqlite::params![
                    install_id,
                    state,
                    subscriber_id,
                    if state == "claimed" {
                        Some(now_ms as i64)
                    } else {
                        None::<i64>
                    },
                    now_ms as i64
                ],
            )?;
            Ok(())
        })
    }

    /// Current claim state for an install, or `None` if never attempted.
    pub fn claim_state(&self, install_id: &str) -> RovenueResult<Option<String>> {
        self.store.with_conn(|c| {
            let s: Option<String> = c
                .query_row(
                    "SELECT state FROM funnel_claim_state WHERE install_id = ?1",
                    [install_id],
                    |r| r.get(0),
                )
                .ok();
            Ok(s)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> CacheStore {
        CacheStore::open_in_memory().expect("open in-memory store")
    }

    #[test]
    fn install_id_is_stable_across_calls() {
        let s = store();
        let repo = FunnelRepo::new(&s);
        let a = repo.get_or_create_install_id(1000).unwrap();
        let b = repo.get_or_create_install_id(2000).unwrap();
        assert!(a.starts_with("inst_"));
        assert_eq!(a, b, "install_id must persist, not regenerate");
    }

    #[test]
    fn claim_state_roundtrips() {
        let s = store();
        let repo = FunnelRepo::new(&s);
        assert_eq!(repo.claim_state("inst_x").unwrap(), None);
        repo.set_claim_state("inst_x", "claimed", Some("sub_1"), 5000)
            .unwrap();
        assert_eq!(repo.claim_state("inst_x").unwrap(), Some("claimed".into()));
    }

    #[test]
    fn claimed_at_ms_only_set_when_claimed() {
        let s = store();
        let repo = FunnelRepo::new(&s);
        repo.set_claim_state("inst_p", "pending", None, 1000)
            .unwrap();
        repo.set_claim_state("inst_c", "claimed", Some("sub_1"), 2000)
            .unwrap();
        let read = |iid: &str| -> Option<i64> {
            s.with_conn(|c| {
                c.query_row(
                    "SELECT claimed_at_ms FROM funnel_claim_state WHERE install_id = ?1",
                    [iid],
                    |r| r.get::<_, Option<i64>>(0),
                )
            })
            .unwrap()
        };
        assert_eq!(read("inst_p"), None, "pending must not stamp claimed_at_ms");
        assert_eq!(read("inst_c"), Some(2000));
    }

    #[test]
    fn claimed_at_ms_clears_on_conflict_to_pending() {
        let s = store();
        let repo = FunnelRepo::new(&s);
        repo.set_claim_state("inst_flip", "claimed", Some("sub_1"), 2000)
            .unwrap();
        repo.set_claim_state("inst_flip", "pending", None, 3000)
            .unwrap();
        let read = |iid: &str| -> Option<i64> {
            s.with_conn(|c| {
                c.query_row(
                    "SELECT claimed_at_ms FROM funnel_claim_state WHERE install_id = ?1",
                    [iid],
                    |r| r.get::<_, Option<i64>>(0),
                )
            })
            .unwrap()
        };
        assert_eq!(
            read("inst_flip"),
            None,
            "claimed→pending flip must clear claimed_at_ms"
        );
    }
}
