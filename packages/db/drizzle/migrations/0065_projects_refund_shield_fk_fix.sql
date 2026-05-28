ALTER TABLE "projects" DROP CONSTRAINT "projects_refund_shield_consent_acknowledged_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_refund_shield_consent_acknowledged_by_user_id_fk" FOREIGN KEY ("refund_shield_consent_acknowledged_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;