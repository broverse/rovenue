CREATE TYPE "public"."NotificationSuppressionReason" AS ENUM('hard_bounce', 'complaint', 'manual');--> statement-breakpoint
CREATE TABLE "notification_suppression_list" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" "NotificationSuppressionReason" NOT NULL,
	"source" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
