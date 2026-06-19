CREATE TABLE "revenue_event_dedupe" (
	"projectId" text NOT NULL,
	"dedupeKey" text NOT NULL,
	"revenueEventId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_event_dedupe_projectId_dedupeKey_pk" PRIMARY KEY("projectId","dedupeKey")
);
--> statement-breakpoint
ALTER TABLE "revenue_events" ADD COLUMN "dedupeKey" text;--> statement-breakpoint
ALTER TABLE "revenue_event_dedupe" ADD CONSTRAINT "revenue_event_dedupe_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;