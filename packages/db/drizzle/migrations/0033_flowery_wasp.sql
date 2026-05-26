ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_userId_user_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "userId" DROP NOT NULL;