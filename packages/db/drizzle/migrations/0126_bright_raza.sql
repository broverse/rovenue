CREATE TABLE "project_retention_overrides" (
	"projectId" text NOT NULL,
	"tableName" text NOT NULL,
	"retentionDays" integer NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_retention_overrides_projectId_tableName_pk" PRIMARY KEY("projectId","tableName"),
	CONSTRAINT "project_retention_overrides_days_positive" CHECK ("project_retention_overrides"."retentionDays" > 0)
);
--> statement-breakpoint
ALTER TABLE "project_retention_overrides" ADD CONSTRAINT "project_retention_overrides_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;