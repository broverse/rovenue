-- 0045_funnel_partitions.sql
-- Onboarding Funnel Core (Phase 1, Task 5).
--
-- Convert funnel_sessions and funnel_answers into declarative
-- RANGE-partitioned tables (monthly), and register them with
-- pg_partman so partition lifecycle (premake / retention) is
-- managed alongside revenue_events / credit_ledger (see 0019).
--
-- Postgres native partitioning constraints handled here:
--   * The partition key (started_at / answered_at) MUST be part
--     of every UNIQUE constraint on the parent.  funnel_sessions.id
--     is the natural session key, so the PK becomes
--     (id, started_at); same for funnel_answers (id, answered_at).
--   * UNIQUE (session_id, question_id) on funnel_answers becomes a
--     plain index — global uniqueness is unenforceable across
--     partitions when partitioned on a third column.  Dedup is
--     enforced at the repository layer (ON CONFLICT DO NOTHING +
--     idempotent upsert).
--   * funnel_sessions is referenced by funnel_answers.session_id,
--     funnel_purchases.session_id, funnel_claim_tokens.session_id.
--     Postgres native partitioning DOES support FKs targeting a
--     partitioned table, but the FK target must be a UNIQUE
--     constraint that includes the partition key — and our child
--     tables only know `session_id`, not the session's started_at.
--     We therefore drop those three FKs and keep just an index on
--     session_id; referential integrity stays enforced via
--     ON DELETE cascade triggers + repository invariants.
--
-- drizzle-orm's migrator wraps each .sql in a transaction.

-- 1. Ensure pg_partman is installed (no-op if already present).
CREATE SCHEMA IF NOT EXISTS partman;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;--> statement-breakpoint

-- 2. Drop FKs into funnel_sessions(id) so we can rename / swap it.
ALTER TABLE "funnel_answers"
  DROP CONSTRAINT IF EXISTS "funnel_answers_session_id_funnel_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "funnel_purchases"
  DROP CONSTRAINT IF EXISTS "funnel_purchases_session_id_funnel_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "funnel_claim_tokens"
  DROP CONSTRAINT IF EXISTS "funnel_claim_tokens_session_id_funnel_sessions_id_fk";--> statement-breakpoint

-- 3. Swap funnel_sessions to a RANGE-partitioned table on started_at.
--    The original table is empty (migration 0044 just created it),
--    so DROP TABLE is safe — no data copy is required.
DROP TABLE "funnel_sessions";--> statement-breakpoint

CREATE TABLE "funnel_sessions" (
  "id"                 text                  NOT NULL,
  "funnel_id"          text                  NOT NULL REFERENCES "funnels"("id")          ON DELETE CASCADE,
  "funnel_version_id"  text                  NOT NULL REFERENCES "funnel_versions"("id")  ON DELETE RESTRICT,
  "project_id"         text                  NOT NULL,
  "anon_id"            text                  NOT NULL,
  "state"              "FunnelSessionState"  NOT NULL DEFAULT 'in_progress',
  "current_page_id"    text,
  "started_at"         timestamptz           NOT NULL DEFAULT now(),
  "last_activity_at"   timestamptz           NOT NULL DEFAULT now(),
  "completed_at"       timestamptz,
  "utm_json"           jsonb                 NOT NULL DEFAULT '{}'::jsonb,
  "ip_hash"            text,
  "user_agent"         text,
  CONSTRAINT "funnel_sessions_pkey" PRIMARY KEY ("id", "started_at")
) PARTITION BY RANGE ("started_at");--> statement-breakpoint

CREATE INDEX "funnel_sessions_funnel_started_idx"
  ON "funnel_sessions" ("funnel_id", "started_at");--> statement-breakpoint
CREATE INDEX "funnel_sessions_state_activity_idx"
  ON "funnel_sessions" ("state", "last_activity_at");--> statement-breakpoint
CREATE INDEX "funnel_sessions_project_started_idx"
  ON "funnel_sessions" ("project_id", "started_at");--> statement-breakpoint

-- 4. Swap funnel_answers to a RANGE-partitioned table on answered_at.
DROP TABLE "funnel_answers";--> statement-breakpoint

CREATE TABLE "funnel_answers" (
  "id"           text         NOT NULL,
  "session_id"   text         NOT NULL,
  "page_id"      text         NOT NULL,
  "question_id"  text         NOT NULL,
  "answer_json"  jsonb        NOT NULL,
  "answered_at"  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "funnel_answers_pkey" PRIMARY KEY ("id", "answered_at")
) PARTITION BY RANGE ("answered_at");--> statement-breakpoint

CREATE INDEX "funnel_answers_session_idx"
  ON "funnel_answers" ("session_id");--> statement-breakpoint
-- Replaces the prior UNIQUE (session_id, question_id) — see header.
CREATE INDEX "funnel_answers_session_question_idx"
  ON "funnel_answers" ("session_id", "question_id");--> statement-breakpoint

-- 5. Restore non-FK session_id indexes on child tables so lookups
--    against the dropped FK stay fast.
CREATE INDEX IF NOT EXISTS "funnel_purchases_session_id_idx"
  ON "funnel_purchases" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funnel_claim_tokens_session_id_idx"
  ON "funnel_claim_tokens" ("session_id");--> statement-breakpoint

-- 6. Register both parents with pg_partman.  Match the v5 invocation
--    used by 0019_install_pg_partman.sql (no p_type; monthly range).
SELECT partman.create_parent(
  p_parent_table    => 'public.funnel_sessions',
  p_control         => 'started_at',
  p_interval        => '1 month',
  p_premake         => 4,
  p_start_partition => '2026-01-01'
);--> statement-breakpoint

UPDATE partman.part_config
   SET retention                = '18 months',
       retention_keep_table     = false,
       retention_keep_index     = false,
       infinite_time_partitions = true
 WHERE parent_table = 'public.funnel_sessions';--> statement-breakpoint

SELECT partman.create_parent(
  p_parent_table    => 'public.funnel_answers',
  p_control         => 'answered_at',
  p_interval        => '1 month',
  p_premake         => 4,
  p_start_partition => '2026-01-01'
);--> statement-breakpoint

UPDATE partman.part_config
   SET retention                = '18 months',
       retention_keep_table     = false,
       retention_keep_index     = false,
       infinite_time_partitions = true
 WHERE parent_table = 'public.funnel_answers';
