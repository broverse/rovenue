-- Per-project, per-store commission rate configuration (Task 4:
-- analytics-integrity-and-proceeds spec §4.3). No existing project-settings
-- or store-config table could hold this cleanly — it's per-store, so a
-- scalar column on `projects` would need to be a map — so it gets its own
-- table, PK'd on (projectId, store) so at most one rate is configured per
-- store per project.
--
-- The rate is never inferred: it's the customer's own statement of their
-- situation (Apple's Small Business Program tier depends on prior-year
-- proceeds across the developer's whole account, which we cannot see).
-- Absence of a row means "no rate configured" and callers must render "no
-- proceeds estimate available", not a silent 0%. See
-- apps/api/src/services/metrics/proceeds.ts for the preset constants,
-- citations, and query-time arithmetic that consumes this table.
CREATE TABLE "project_store_commission_rates" (
	"projectId" text NOT NULL,
	"store" "Store" NOT NULL,
	"rate" numeric(5, 4) NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_store_commission_rates_projectId_store_pk" PRIMARY KEY("projectId","store"),
	CONSTRAINT "project_store_commission_rates_rate_bounds" CHECK ("project_store_commission_rates"."rate" >= 0 AND "project_store_commission_rates"."rate" <= 1)
);
--> statement-breakpoint
ALTER TABLE "project_store_commission_rates" ADD CONSTRAINT "project_store_commission_rates_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;