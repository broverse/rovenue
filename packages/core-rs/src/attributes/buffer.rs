use std::sync::Arc;

use crate::cache::store::{AttributeMutationRow, CacheStore};
use crate::error::RovenueResult;

/// Local dirty-mutation queue for subscriber attributes. Unlike the
/// session buffer, callers `list` then `delete` separately so the
/// dispatcher can keep rows queued when a flush fails (attributes are
/// durable user data, not fire-and-forget telemetry).
pub struct AttributeBuffer {
    store: Arc<CacheStore>,
}

impl AttributeBuffer {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }

    /// Queue a single attribute mutation. `None` value means delete.
    pub fn set(&self, key: &str, value: Option<&str>) -> RovenueResult<()> {
        self.store.append_attribute_mutation(key, value)
    }

    pub fn list(&self, limit: usize) -> RovenueResult<Vec<AttributeMutationRow>> {
        self.store.list_attribute_mutations(limit)
    }

    pub fn delete(&self, ids: &[i64]) -> RovenueResult<()> {
        self.store.delete_attribute_mutations(ids)
    }

    pub fn clear(&self) -> RovenueResult<()> {
        self.store.clear_attribute_mutations()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::store::CacheStore;
    use std::sync::Arc;

    #[test]
    fn set_appends_and_list_delete_roundtrip() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = AttributeBuffer::new(Arc::clone(&store));
        buf.set("$email", Some("a@b.com")).unwrap();
        buf.set("country", None).unwrap();

        let rows = buf.list(100).unwrap();
        assert_eq!(rows.len(), 2);

        buf.delete(&rows.iter().map(|r| r.id).collect::<Vec<_>>())
            .unwrap();
        assert_eq!(buf.list(100).unwrap().len(), 0);
    }

    #[test]
    fn clear_empties_the_queue() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let buf = AttributeBuffer::new(Arc::clone(&store));
        buf.set("k", Some("v")).unwrap();
        buf.clear().unwrap();
        assert_eq!(buf.list(100).unwrap().len(), 0);
    }
}
