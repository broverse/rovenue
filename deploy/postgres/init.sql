-- Plan 3 §G.1 — placeholder for /docker-entrypoint-initdb.d/.
-- The pg_partman extension itself is created by Drizzle migration
-- 0019_install_pg_partman.sql so the migration history reflects
-- the install. This file is intentionally minimal so the entrypoint
-- has something to run on first boot if we add operator-side setup
-- (custom GUCs, role grants) later.
SELECT 1;
