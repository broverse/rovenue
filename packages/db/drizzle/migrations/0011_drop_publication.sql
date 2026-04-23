-- Roll back the rovenue_analytics logical-replication publication
-- introduced in 0010. The PeerDB CDC pipeline that consumed it is
-- removed in Phase A of the Kafka+outbox plan (spec §14); without a
-- consumer the publication holds WAL segments and leaks disk, so we
-- drop it unconditionally. If no PeerDB mirror was ever started
-- (common in local dev), the publication still exists from 0010 —
-- the IF EXISTS guard keeps this migration safe.
--
-- wal_level=logical / max_wal_senders / max_replication_slots stay
-- on in docker-compose.yml — they were introduced alongside 0010
-- but are harmless without a subscriber, and a future reintroduction
-- of logical replication (for a different purpose) should not have
-- to re-sequence a full Postgres restart.
--
-- drizzle-orm's migrator wraps each .sql in a transaction — no
-- BEGIN/COMMIT here. DROP PUBLICATION is transactional in PG16.

DROP PUBLICATION IF EXISTS rovenue_analytics;
