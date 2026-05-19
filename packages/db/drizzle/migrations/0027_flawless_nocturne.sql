CREATE TABLE "chart_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"userId" text,
	"occurredAt" timestamp with time zone NOT NULL,
	"endsAt" timestamp with time zone,
	"label" text NOT NULL,
	"description" text,
	"color" text,
	"url" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_chart_views" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chart_annotations" ADD CONSTRAINT "chart_annotations_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_annotations" ADD CONSTRAINT "chart_annotations_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_chart_views" ADD CONSTRAINT "saved_chart_views_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_chart_views" ADD CONSTRAINT "saved_chart_views_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chart_annotations_projectId_occurredAt_idx" ON "chart_annotations" USING btree ("projectId","occurredAt");--> statement-breakpoint
CREATE INDEX "saved_chart_views_projectId_updatedAt_idx" ON "saved_chart_views" USING btree ("projectId","updatedAt");--> statement-breakpoint
CREATE INDEX "saved_chart_views_projectId_userId_idx" ON "saved_chart_views" USING btree ("projectId","userId");