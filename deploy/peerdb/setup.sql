-- deploy/peerdb/setup.sql
--
-- One-shot bootstrap for the rovenue analytics mirror. Apply against
-- PeerDB's wire endpoint with:
--
--   psql "postgresql://peerdb:peerdb@localhost:9900/peerdb" \
--        -f deploy/peerdb/setup.sql
--
-- Re-running is NOT idempotent — CREATE PEER / CREATE MIRROR fail
-- loudly if the named object already exists. The canonical recovery
-- is: `DROP MIRROR rovenue_analytics; DROP PEER rovenue_clickhouse;
-- DROP PEER rovenue_postgres;` (or the PeerDB UI), then re-apply.
--
-- Host addresses: PeerDB runs in its own docker network (deployed
-- via deploy/peerdb/upstream/run-peerdb.sh), so rovenue's services
-- are reachable at host.docker.internal:<host-port>. On Linux hosts
-- without Docker Desktop, add `--add-host=host.docker.internal:
-- host-gateway` to the PeerDB compose services (PeerDB's own
-- run-peerdb.sh already does this on recent versions).

-- Source: rovenue's Postgres (with TimescaleDB).
CREATE PEER rovenue_postgres FROM POSTGRES WITH (
  host = 'host.docker.internal',
  port = '5433',
  user = 'rovenue',
  password = 'rovenue',
  database = 'rovenue'
);

-- Target: rovenue's ClickHouse. PeerDB connects over the native
-- TCP protocol (container port 9000 → host 9002), NOT HTTP (8123 →
-- 8124). Using the HTTP port triggers `handshake unexpected packet
-- [72]` (ASCII 'H' from "HTTP/..."). disable_tls is fine for local
-- dev; production terminates TLS at the reverse proxy and flips
-- this off in a follow-up migration.
CREATE PEER rovenue_clickhouse FROM CLICKHOUSE WITH (
  host = 'host.docker.internal',
  port = 9102,
  user = 'rovenue',
  password = 'rovenue',
  database = 'rovenue',
  disable_tls = true
);

-- Mirror: continuous CDC from Postgres → ClickHouse. Uses the
-- publication created by Drizzle migration 0010
-- (packages/db/drizzle/migrations/0010_postgres_publication.sql).
--
-- Table mapping: source `public.<table>` → target `<ch_table>`. Per
-- PeerDB docs, ClickHouse target tables MUST NOT be schema-qualified
-- (the database is set at peer level).
--
-- soft_delete = true keeps Postgres DELETEs as tombstones in
-- ClickHouse (row marked _peerdb_is_deleted = 1) rather than
-- physical removal — matches rovenue's 7-year retention intent
-- and lets Phase 4.5's MVs filter deleted rows at read time.
CREATE MIRROR rovenue_analytics
FROM rovenue_postgres TO rovenue_clickhouse
WITH TABLE MAPPING (
  public.revenue_events:raw_revenue_events,
  public.credit_ledger:raw_credit_ledger,
  public.subscribers:raw_subscribers,
  public.purchases:raw_purchases,
  public.experiment_assignments:raw_experiment_assignments,
  public.exposure_events:raw_exposures
)
WITH (
  do_initial_copy = true,
  publication_name = 'rovenue_analytics',
  soft_delete = true,
  synced_at_col_name = '_peerdb_synced_at',
  soft_delete_col_name = '_peerdb_is_deleted',
  snapshot_num_tables_in_parallel = 2,
  snapshot_num_rows_per_partition = 100000,
  max_batch_size = 100000,
  sync_interval = 60
);
