-- ADD VALUE must run outside an explicit transaction block, but Postgres
-- already runs each migration in an implicit one. Splitting these
-- variants into a separate file (with `--> statement-breakpoint`) lets
-- drizzle-kit issue each in its own statement, which Postgres 16 accepts.

ALTER TYPE "MemberRole" ADD VALUE IF NOT EXISTS 'DEVELOPER';
--> statement-breakpoint
ALTER TYPE "MemberRole" ADD VALUE IF NOT EXISTS 'GROWTH';
--> statement-breakpoint
ALTER TYPE "MemberRole" ADD VALUE IF NOT EXISTS 'CUSTOMER_SUPPORT';
