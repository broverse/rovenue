-- =============================================================
-- user_preferences.profile — Phase 2 Account / Identity
-- =============================================================
--
-- A third opaque JSON blob alongside `notifications` and
-- `appearance` so the profile page can persist its non-identity
-- fields (displayName, phone, role, company, bio, avatarColor)
-- without one column per field. The dashboard owns the key
-- shapes; the backend treats it as opaque storage.

ALTER TABLE "user_preferences"
  ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;
