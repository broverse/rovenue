CREATE TYPE "public"."ScheduledActionStatus" AS ENUM('PENDING', 'EXECUTED', 'CANCELED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."ScheduledActionType" AS ENUM('CANCEL');--> statement-breakpoint
ALTER TYPE "public"."Store" ADD VALUE 'MANUAL';--> statement-breakpoint
CREATE TABLE "scheduled_subscription_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"purchaseId" text NOT NULL,
	"subscriberId" text NOT NULL,
	"action" "ScheduledActionType" NOT NULL,
	"dueAt" timestamp with time zone NOT NULL,
	"status" "ScheduledActionStatus" DEFAULT 'PENDING' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdBy" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"executedAt" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "scheduled_subscription_actions" ADD CONSTRAINT "scheduled_subscription_actions_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_subscription_actions" ADD CONSTRAINT "scheduled_subscription_actions_purchaseId_purchases_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_subscription_actions" ADD CONSTRAINT "scheduled_subscription_actions_subscriberId_subscribers_id_fk" FOREIGN KEY ("subscriberId") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_actions_projectId_status_idx" ON "scheduled_subscription_actions" USING btree ("projectId","status");--> statement-breakpoint
CREATE INDEX "scheduled_actions_status_dueAt_idx" ON "scheduled_subscription_actions" USING btree ("status","dueAt");