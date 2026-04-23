-- Convert revenue_events to a TimescaleDB hypertable partitioned by
-- eventDate. Partition column MUST be in every UNIQUE / PRIMARY KEY
-- on the table (TimescaleDB constraint), so we first rewrite the PK
-- from (id) to (id, eventDate).
--
-- cuid2 already guarantees global uniqueness at the application
-- layer; no other table references revenue_events.id via FK, so
-- dropping the single-column PK is safe.
--
-- drizzle-orm's migrator already wraps each .sql file in a
-- transaction — do NOT add BEGIN/COMMIT here.

ALTER TABLE "revenue_events" DROP CONSTRAINT "revenue_events_pkey";
ALTER TABLE "revenue_events"
  ADD CONSTRAINT "revenue_events_pkey" PRIMARY KEY ("id", "eventDate");

-- 1-day chunks match the dashboard query pattern (daily MRR buckets)
-- and keep the chunk count bounded at ~365/year — well under the
-- max_locks_per_transaction ceiling (spec T7).
SELECT create_hypertable(
  '"revenue_events"',
  by_range('eventDate', INTERVAL '1 day'),
  migrate_data => true,
  if_not_exists => true
);
