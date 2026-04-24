-- Logical replication publication feeding PeerDB. Includes every
-- table that the rovenue_analytics mirror (deploy/peerdb/setup.sql)
-- replicates into ClickHouse: exposure_events (Phase 3),
-- revenue_events, credit_ledger, subscribers, purchases, and
-- experiment_assignments.
--
-- Prerequisites (docker-compose.yml db service command):
--   wal_level=logical
--   max_wal_senders=10
--   max_replication_slots=10
-- Without these, CREATE PUBLICATION is silently accepted but PeerDB
-- cannot actually consume it.
--
-- PeerDB creates its own replication slot via the flow-worker; we do
-- NOT pre-create one here. Keeping the slot lifecycle inside PeerDB's
-- catalog means `peerdb mirrors drop` / resync commands can tear it
-- down cleanly.
--
-- Idempotency: CREATE PUBLICATION has no IF NOT EXISTS form in PG16
-- (added in PG17). The DO block below checks pg_publication first so
-- re-applying the migration is a no-op.
--
-- drizzle-orm's migrator wraps each .sql in a transaction — no
-- BEGIN/COMMIT here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'rovenue_analytics') THEN
    CREATE PUBLICATION rovenue_analytics FOR TABLE
      "revenue_events",
      "credit_ledger",
      "subscribers",
      "purchases",
      "experiment_assignments",
      "exposure_events"
    WITH (publish = 'insert, update, delete');
  END IF;
END $$;

-- Grant SELECT on the source tables to the rovenue role. In local
-- dev rovenue already owns the tables; in production with a
-- dedicated rovenue_replication role this grant is what PeerDB's
-- connection actually relies on.
GRANT SELECT ON
  "revenue_events",
  "credit_ledger",
  "subscribers",
  "purchases",
  "experiment_assignments",
  "exposure_events"
TO rovenue;
