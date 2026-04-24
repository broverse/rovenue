-- Roll back the exposure_events TimescaleDB hypertable introduced
-- in 0009. Per spec §14.2 / §14.7 exposure_events is a pure
-- analytics event with no OLTP read path; after the Kafka pivot it
-- lives only in ClickHouse (raw_exposures, populated by the Kafka
-- Engine table in clickhouse/migrations/0002_exposures_kafka_engine.sql).
--
-- CASCADE drops the associated compression + retention policies,
-- chunk indexes, and TimescaleDB catalog entries in one shot. The
-- table is empty in dev and was never deployed to production, so
-- data loss is not a concern.
--
-- IF EXISTS handles the case where 0009 was never applied (fresh
-- branch checkout).

DROP TABLE IF EXISTS "exposure_events" CASCADE;
