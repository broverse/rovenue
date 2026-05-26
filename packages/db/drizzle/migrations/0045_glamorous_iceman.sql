-- 0042_glamorous_iceman.sql
-- Notifications inbox + per-channel delivery records.
--
-- Both tables are plain (non-partitioned). pg_partman is not installed
-- in this DB; existing hot tables (revenue_events_*, credit_ledger_*)
-- are also unmanaged plain heap partitions created by hand-rolled
-- migrations, not by partman. To stay consistent and avoid scope creep
-- we keep notifications + deliveries as regular tables for v1. Add
-- simple cron-based retention later if volume demands.

CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"projectId" text,
	"eventKey" text NOT NULL,
	"eventId" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"readAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_userId_eventId_key" ON "notifications" USING btree ("userId","eventId");--> statement-breakpoint
CREATE INDEX "notifications_userId_feed_idx" ON "notifications" USING btree ("userId","readAt","createdAt");--> statement-breakpoint

CREATE TABLE "notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"notificationId" text NOT NULL,
	"channel" "NotificationChannel" NOT NULL,
	"status" "NotificationDeliveryStatus" NOT NULL,
	"providerMessageId" text,
	"providerResponse" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastAttemptAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_notifications_id_fk" FOREIGN KEY ("notificationId") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_deliveries_notificationId_idx" ON "notification_deliveries" USING btree ("notificationId");--> statement-breakpoint
CREATE INDEX "notification_deliveries_status_idx" ON "notification_deliveries" USING btree ("status","createdAt");
