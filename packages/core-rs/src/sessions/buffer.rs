use std::sync::Arc;

use crate::cache::store::SessionEventRow;
use crate::cache::CacheStore;
use crate::error::RovenueResult;

use super::SessionEventKind;

pub struct SessionBuffer {
    store: Arc<CacheStore>,
}

impl SessionBuffer {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }

    pub fn record(
        &self,
        kind: SessionEventKind,
        occurred_at: &str,
        duration_ms: Option<u32>,
    ) -> RovenueResult<()> {
        self.store
            .append_session_event(kind.as_wire(), occurred_at, duration_ms)
    }

    pub fn drain(&self, limit: usize) -> RovenueResult<Vec<SessionEventRow>> {
        let rows = self.store.list_session_events(limit)?;
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        self.store.delete_session_events(&ids)?;
        Ok(rows)
    }

    /// Discards every buffered event. Called on log_out so undispatched events do
    /// not flush under the next identity scope.
    pub fn clear(&self) -> RovenueResult<()> {
        self.store.clear_session_events()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::CacheStore;
    use std::sync::Arc;

    #[test]
    fn record_appends_to_store() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = SessionBuffer::new(Arc::clone(&store));
        buf.record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None)
            .unwrap();
        buf.record(
            SessionEventKind::Background,
            "2026-05-28T10:05:00Z",
            Some(300_000),
        )
        .unwrap();
        let rows = store.list_session_events(10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].kind, "open");
        assert_eq!(rows[1].kind, "background");
        assert_eq!(rows[1].duration_ms, Some(300_000));
    }

    #[test]
    fn clear_discards_all_events() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = SessionBuffer::new(Arc::clone(&store));
        buf.record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None)
            .unwrap();
        buf.record(SessionEventKind::Close, "2026-05-28T10:05:00Z", None)
            .unwrap();
        assert_eq!(store.list_session_events(10).unwrap().len(), 2);
        buf.clear().unwrap();
        assert_eq!(store.list_session_events(10).unwrap().len(), 0);
    }

    #[test]
    fn drain_returns_and_deletes() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = SessionBuffer::new(Arc::clone(&store));
        buf.record(SessionEventKind::Open, "2026-05-28T10:00:00Z", None)
            .unwrap();
        let drained = buf.drain(100).unwrap();
        assert_eq!(drained.len(), 1);
        assert_eq!(store.list_session_events(10).unwrap().len(), 0);
    }
}
