-- Plan 3 §G.1 — placeholder for /docker-entrypoint-initdb.d/.
-- The pg_partman extension itself is created by Drizzle migrations
-- (0019 on the upgrade path; 0051/0060/0130, which all use
-- CREATE EXTENSION IF NOT EXISTS, on a fresh install where 0019 is
-- skipped) so the migration history reflects the install. This file is
-- intentionally minimal so the entrypoint has something to run on first
-- boot if we add operator-side setup (custom GUCs, role grants) later.
SELECT 1;
