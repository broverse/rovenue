-- One-shot MemberRole rebuild. Replaces VIEWER with CUSTOMER_SUPPORT and
-- introduces DEVELOPER + GROWTH in the same transaction. Done via a
-- CREATE TYPE / ALTER COLUMN USING / DROP / RENAME swap instead of
-- ADD VALUE so we don't hit Postgres's "unsafe use of new enum value
-- in the same transaction" guard.

CREATE TYPE "MemberRole_new" AS ENUM (
  'OWNER', 'ADMIN', 'DEVELOPER', 'GROWTH', 'CUSTOMER_SUPPORT'
);--> statement-breakpoint

ALTER TABLE project_members
  ALTER COLUMN role TYPE "MemberRole_new"
  USING CASE
    WHEN role::text = 'VIEWER' THEN 'CUSTOMER_SUPPORT'::"MemberRole_new"
    ELSE role::text::"MemberRole_new"
  END;--> statement-breakpoint

DROP TYPE "MemberRole";--> statement-breakpoint
ALTER TYPE "MemberRole_new" RENAME TO "MemberRole";
