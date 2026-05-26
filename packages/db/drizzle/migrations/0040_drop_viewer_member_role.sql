-- Postgres cannot DROP VALUE from an enum, so we rebuild the type.
-- All consumers are migrated to CUSTOMER_SUPPORT in 0039, so this is
-- a clean swap.

CREATE TYPE "MemberRole_new" AS ENUM (
  'OWNER', 'ADMIN', 'DEVELOPER', 'GROWTH', 'CUSTOMER_SUPPORT'
);
--> statement-breakpoint
ALTER TABLE project_members
  ALTER COLUMN role TYPE "MemberRole_new"
  USING role::text::"MemberRole_new";
--> statement-breakpoint
DROP TYPE "MemberRole";
--> statement-breakpoint
ALTER TYPE "MemberRole_new" RENAME TO "MemberRole";
