-- Retention policies. Dropped chunks go away instantly (DROP CHUNK,
-- not DELETE) so there is no vacuum overhead — spec §1.3.
--
-- TSL-gated: add_retention_policy uses the TimescaleDB job scheduler
-- which requires timescaledb.license=timescale (see docker-compose.yml).
-- Does NOT work under apache license.
--
-- revenue_events and credit_ledger deliberately have NO retention
-- policy: financial records must survive 7+ years for tax/audit
-- (Turkish VUK minimum is 5 years). Operators who want a hard cutoff
-- add a policy later via an explicit migration.

SELECT add_retention_policy('outgoing_webhooks', INTERVAL '90 days');
