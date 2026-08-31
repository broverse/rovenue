-- 0105_import_jobs.sql
--
-- import_jobs: persistence for bulk history import (RevenueCat first).
-- The pure parsing/mapping core landed in packages/shared/src/import/
-- (Tasks 1-3); this migration adds the row that tracks one operator-
-- initiated import job end to end.
--
-- Row-level per-record outcomes are deliberately NOT stored here — they
-- stream to a report file in object storage (reportStorageKey) so a
-- million-row import doesn't double the write volume for data nobody
-- queries. This table holds aggregate `counters` (jsonb) instead.
--
-- NOTE: `drizzle-kit generate` swept in two unrelated statements against
-- integration_connections / integration_deliveries (a DROP+CREATE of
-- integration_connections_project_provider_uidx and a redundant
-- provider_id ALTER ... SET DATA TYPE text) — bookkeeping-only drift left
-- over from migration 0104 having been hand-written outside `generate`.
-- Both are no-ops against the already-applied 0104 state and were
-- trimmed. Separately, the generator dropped the CREATE TYPE statement
-- for the new "ImportJobStatus" enum entirely (same meta-drift cause);
-- it is added back by hand below, matching the format of every other
-- hand-verified enum migration in this journal (e.g. 0060, 0093).

CREATE TYPE "public"."ImportJobStatus" AS ENUM('PENDING_MAPPING', 'DRY_RUN_RUNNING', 'DRY_RUN_COMPLETE', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"created_by_user_id" text,
	"source_label" text NOT NULL,
	"preset_id" text,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"file_bytes" integer NOT NULL,
	"file_sha256" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "ImportJobStatus" DEFAULT 'PENDING_MAPPING' NOT NULL,
	"checkpoint_line" integer DEFAULT 0 NOT NULL,
	"counters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"report_storage_key" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_jobs_project_created_at_idx" ON "import_jobs" USING btree ("project_id","created_at");
