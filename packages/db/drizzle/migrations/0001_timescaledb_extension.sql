-- TimescaleDB extension registration.
-- The extension binaries ship with the timescale/timescaledb:2.17.2-pg16
-- image. This migration opts the rovenue database into the extension
-- so CREATE_HYPERTABLE and CREATE MATERIALIZED VIEW ... WITH
-- (timescaledb.continuous) work in the migrations that follow.
--
-- IF NOT EXISTS so reruns on the same database are no-ops.
CREATE EXTENSION IF NOT EXISTS timescaledb;
