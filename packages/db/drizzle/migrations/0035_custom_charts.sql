CREATE TABLE "custom_charts" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"createdByUserId" text,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"chartType" text NOT NULL,
	"rangeOption" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_charts" ADD CONSTRAINT "custom_charts_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_charts" ADD CONSTRAINT "custom_charts_createdByUserId_user_id_fk" FOREIGN KEY ("createdByUserId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_charts_projectId_updatedAt_idx" ON "custom_charts" USING btree ("projectId","updatedAt");