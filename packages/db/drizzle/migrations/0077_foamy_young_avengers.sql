CREATE TABLE "warehouse_query_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"userId" text NOT NULL,
	"executedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"durationMs" integer,
	"rowCount" integer
);
--> statement-breakpoint
ALTER TABLE "warehouse_query_runs" ADD CONSTRAINT "warehouse_query_runs_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_query_runs" ADD CONSTRAINT "warehouse_query_runs_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "warehouse_query_runs_projectId_executedAt_idx" ON "warehouse_query_runs" USING btree ("projectId","executedAt");