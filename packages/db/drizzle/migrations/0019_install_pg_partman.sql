-- 0019_install_pg_partman.sql
-- Plan 3 §F.1 — install pg_partman + register revenue_events and
-- credit_ledger parents with a 7-year retention window (VUK).
--
-- Pre-req: 0018_drop_timescaledb_extension applied.
-- Pre-req: Phase G image swap deployed (postgres:16-bookworm + the
--          apt package `postgresql-16-partman`). The .so isn't in
--          the legacy timescale/timescaledb image.
--
-- pg_partman v5 syntax: `p_type` removed (always range / native).
-- If the bookworm apt package surfaces v4 here, add `p_type => 'native'`.
-- `outgoing_webhooks` is intentionally NOT registered: the 90-day
-- retention sweep is a composite predicate (status + age) and stays
-- on the existing webhook-retention worker. Its monthly partitions
-- are pre-created by the partition-maintenance worker (F.3).

CREATE SCHEMA IF NOT EXISTS partman;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;--> statement-breakpoint

SELECT partman.create_parent(
  p_parent_table    => 'public.revenue_events',
  p_control         => 'eventDate',
  p_interval        => '1 month',
  p_premake         => 12,
  p_start_partition => '2024-01-01'
);--> statement-breakpoint

UPDATE partman.part_config
   SET retention                = '7 years',
       retention_keep_table     = false,
       retention_keep_index     = false,
       infinite_time_partitions = true
 WHERE parent_table = 'public.revenue_events';--> statement-breakpoint

SELECT partman.create_parent(
  p_parent_table    => 'public.credit_ledger',
  p_control         => 'createdAt',
  p_interval        => '1 month',
  p_premake         => 12,
  p_start_partition => '2024-01-01'
);--> statement-breakpoint

UPDATE partman.part_config
   SET retention                = '7 years',
       retention_keep_table     = false,
       retention_keep_index     = false,
       infinite_time_partitions = true
 WHERE parent_table = 'public.credit_ledger';
