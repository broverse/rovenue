ALTER TABLE "projects" ADD COLUMN "refund_shield_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "refund_shield_consent_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "refund_shield_consent_acknowledged_by" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "refund_shield_response_delay_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_refund_shield_consent_acknowledged_by_user_id_fk" FOREIGN KEY ("refund_shield_consent_acknowledged_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;