-- 0101_seed_asset_storage_limits.sql
--
-- 0099 added `billing_tier_limits.asset_storage_bytes_limit` and filled it
-- with UPDATEs. 0100 then seeded the ladder ITSELF with an INSERT whose
-- column list never mentioned it. On a database built from migrations alone
-- — fresh self-host, clean CI, a new cloud deploy — 0099's UPDATEs matched
-- no rows (0100 had not created them yet) and 0100's INSERT wrote NULL, and
-- NULL in this column means unlimited. So every tier of every new
-- deployment had no storage cap at all, while long-lived databases (whose
-- ladder rows predate 0099) did. The `studio` rows are the tell: 0085
-- INSERTed those two by hand, so they were the only ones 0099 could find.
--
-- Same numbers as 0099 — this is a repair, not a repricing.
--
-- `IS NULL` guarded, so it is inert on every database whose rows already
-- carry a number — including numbers an operator tuned by hand. `enterprise`
-- is excluded because its NULL is the real, intended "unlimited".
--
-- It is NOT inert in one case, and that case cannot be detected from here: a
-- deployment that had granted free/indie/studio unlimited storage by setting
-- this column to NULL is indistinguishable from one that was never seeded,
-- and gets the ladder value instead. That is the deliberate direction to fail
-- in — the alternative left every fresh database uncapped — but the setting
-- has to be re-expressed afterwards, and NULL can no longer carry it. Write a
-- NEGATIVE value (-1, `ASSET_STORAGE_UNLIMITED_LIMIT_BYTES`) instead: it is
-- meaningless as a cap, so it cannot be confused with an unfilled row.

UPDATE "billing_tier_limits" SET "asset_storage_bytes_limit" = 262144000
  WHERE "tier" = 'free' AND "asset_storage_bytes_limit" IS NULL;        -- 250 MB
UPDATE "billing_tier_limits" SET "asset_storage_bytes_limit" = 5368709120
  WHERE "tier" = 'indie' AND "asset_storage_bytes_limit" IS NULL;       -- 5 GB
UPDATE "billing_tier_limits" SET "asset_storage_bytes_limit" = 53687091200
  WHERE "tier" = 'studio' AND "asset_storage_bytes_limit" IS NULL;      -- 50 GB
