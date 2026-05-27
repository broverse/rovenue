CREATE TYPE "public"."CustomDomainCertStatus" AS ENUM('pending', 'issuing', 'issued', 'failed');--> statement-breakpoint
CREATE TABLE "custom_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"funnel_id" text NOT NULL,
	"hostname" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"verification_failure_reason" text,
	"cert_status" "CustomDomainCertStatus" DEFAULT 'pending' NOT NULL,
	"cert_issued_at" timestamp with time zone,
	"cert_failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_domains_hostname_unique" ON "custom_domains" USING btree ("hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_domains_funnel_unique" ON "custom_domains" USING btree ("funnel_id");--> statement-breakpoint
CREATE INDEX "custom_domains_project_idx" ON "custom_domains" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "custom_domains_pending_idx" ON "custom_domains" USING btree ("verified_at") WHERE verified_at IS NULL;