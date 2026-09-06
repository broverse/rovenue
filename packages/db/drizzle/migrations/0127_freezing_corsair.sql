CREATE TYPE "public"."DsarRequestStatus" AS ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."DsarRequestType" AS ENUM('EXPORT', 'ERASURE');--> statement-breakpoint
CREATE TABLE "dsar_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"subscriberId" text NOT NULL,
	"type" "DsarRequestType" NOT NULL,
	"status" "DsarRequestStatus" DEFAULT 'PENDING' NOT NULL,
	"requestedBy" text NOT NULL,
	"artifactKey" text,
	"expiresAt" timestamp with time zone,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_subscriberId_subscribers_id_fk" FOREIGN KEY ("subscriberId") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dsar_requests_open_subscriber_type_uniq" ON "dsar_requests" USING btree ("subscriberId","type") WHERE "dsar_requests"."status" IN ('PENDING', 'RUNNING');--> statement-breakpoint
CREATE INDEX "dsar_requests_projectId_idx" ON "dsar_requests" USING btree ("projectId");