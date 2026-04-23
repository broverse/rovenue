-- Records which bucketing algorithm produced each row. Spec §13.7:
-- pre-launch cutover from murmur3 to SHA-256 means every row
-- written today is SHA-256, hence the default. Future algorithm
-- changes ship a new version number; the engine keeps a fallback
-- table {version → hash fn} so live assignments don't break.
--
-- smallint fits us for ~32k distinct hash versions, which is many
-- more than anyone will ever introduce.
--
-- No backfill needed: rovenue is pre-launch, experiment_assignments
-- is empty.

ALTER TABLE "experiment_assignments"
  ADD COLUMN "hashVersion" smallint NOT NULL DEFAULT 1;
