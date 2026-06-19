CREATE TABLE "warehouse_query_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"row_count" integer
);
--> statement-breakpoint
ALTER TABLE "warehouse_query_runs" ADD CONSTRAINT "warehouse_query_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_query_runs" ADD CONSTRAINT "warehouse_query_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "warehouse_query_runs_project_executed_idx" ON "warehouse_query_runs" USING btree ("project_id","executed_at");