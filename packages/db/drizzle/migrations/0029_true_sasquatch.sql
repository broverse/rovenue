CREATE TABLE "saved_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sql" text NOT NULL,
	"mode" text DEFAULT 'sql' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_queries_projectId_updatedAt_idx" ON "saved_queries" USING btree ("projectId","updatedAt");--> statement-breakpoint
CREATE INDEX "saved_queries_projectId_userId_idx" ON "saved_queries" USING btree ("projectId","userId");