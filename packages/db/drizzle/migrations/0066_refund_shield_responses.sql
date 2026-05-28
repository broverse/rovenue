CREATE TYPE "public"."refund_shield_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED_NOT_FOUND', 'SKIPPED_DISABLED');--> statement-breakpoint
CREATE TYPE "public"."refund_shield_outcome" AS ENUM('REFUND_APPROVED', 'REFUND_DECLINED', 'REFUND_REVERSED');--> statement-breakpoint
CREATE TABLE "refund_shield_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"subscriber_id" text,
	"apple_notification_uuid" text NOT NULL,
	"apple_original_transaction_id" text NOT NULL,
	"apple_transaction_id" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"request_payload" jsonb,
	"apple_http_status" integer,
	"apple_response_body" text,
	"status" "refund_shield_status" DEFAULT 'PENDING' NOT NULL,
	"outcome" "refund_shield_outcome",
	"outcome_received_at" timestamp with time zone,
	"error" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refund_shield_responses" ADD CONSTRAINT "refund_shield_responses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_shield_responses" ADD CONSTRAINT "refund_shield_responses_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rss_notification_uniq" ON "refund_shield_responses" USING btree ("apple_notification_uuid");--> statement-breakpoint
CREATE INDEX "idx_rss_due" ON "refund_shield_responses" USING btree ("status","scheduled_for") WHERE "refund_shield_responses"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "idx_rss_outcome_lookup" ON "refund_shield_responses" USING btree ("apple_original_transaction_id");--> statement-breakpoint
CREATE INDEX "idx_rss_dashboard" ON "refund_shield_responses" USING btree ("project_id","detected_at");