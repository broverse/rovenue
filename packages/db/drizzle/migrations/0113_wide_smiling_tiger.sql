CREATE TABLE "apple_external_purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"external_purchase_id" text NOT NULL,
	"token_creation_date" timestamp with time zone,
	"app_apple_id" bigint,
	"webhook_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apple_external_purchases" ADD CONSTRAINT "apple_external_purchases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apple_external_purchases_project_external_id_key" ON "apple_external_purchases" USING btree ("project_id","external_purchase_id");