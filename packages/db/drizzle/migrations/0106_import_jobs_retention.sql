-- 0106_import_jobs_retention.sql
--
-- Task 8 fix round 1:
--
--  FIX 3 — the retention sweep (workers/import-retention.ts) was doing a
--  full sequential scan of `import_jobs` every night (no index on
--  (status, finishedAt), only (projectId, createdAt)), and re-selecting
--  every already-swept job forever, since nothing recorded that a job's
--  files were already deleted. Adds the supporting index plus a
--  `files_deleted_at` marker that the eligibility query now excludes on.
--
--  FIX 5 — a crash-and-resume across `runImportJob` invocations used to
--  lose the report from every earlier, already-checkpointed attempt: the
--  writer overwrote one shared `report_storage_key` object each call.
--  Each attempt that does real work now writes its own immutable report
--  PART (lib/import-store.ts's `buildReportPartStorageKey`, keyed by
--  attempt number — never (re)computed from anything else, so it needs
--  no separate storage-key column of its own); `report_part_count`
--  records how many parts exist so a reader enumerates
--  1..report_part_count in order. `report_storage_key` keeps its
--  original meaning (the dry-run planner's single report object,
--  services/import/plan.ts) untouched.
--
-- NOTE: `drizzle-kit generate` reproduced the SAME meta-drift bug
-- 0105's own comment documents — this time it silently dropped the
-- "ImportJobStatus" enum from its tracked snapshot (packages/db/drizzle/
-- migrations/meta/0106_snapshot.json), which surfaced as a generated
-- `DROP TYPE "public"."ImportJobStatus";` statement in this file that
-- would have destroyed the enum backing `import_jobs.status` on every
-- upgrade-path database. That statement is removed below; the snapshot
-- has been hand-patched to restore the enum entry (copied verbatim from
-- 0105's snapshot) so a future `generate` does not repeat this.

ALTER TABLE "import_jobs" ADD COLUMN "report_part_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "files_deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "import_jobs_status_finished_at_idx" ON "import_jobs" USING btree ("status","finished_at");
