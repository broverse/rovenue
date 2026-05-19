-- =============================================================
-- user.locale + user.timezone — Phase 2 Account / Identity
-- =============================================================
--
-- Dashboard-side preferences for displaying timestamps and i18n
-- copy. Both columns are NOT NULL with sensible defaults so the
-- alter table is non-disruptive on existing rows (Postgres
-- back-fills the default in place). Better Auth's adapter does
-- not touch these columns — the dashboard's PATCH /dashboard/me
-- owns the write side exclusively.

ALTER TABLE "user" ADD COLUMN "locale" text DEFAULT 'en-US' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;
