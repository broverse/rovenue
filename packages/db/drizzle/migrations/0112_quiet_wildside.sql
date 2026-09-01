CREATE TYPE "public"."ExperimentPrimaryMetric" AS ENUM('CONVERSION', 'ARPU', 'PROCEEDS_PER_USER');--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "primaryMetric" "ExperimentPrimaryMetric" DEFAULT 'CONVERSION' NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "minimumDetectableEffect" numeric(5, 4) DEFAULT '0.1' NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "scheduledStartAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "scheduledEndAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "startAfterExperimentId" text;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "autoWinnerOnStop" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "holdout_percentage" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_startAfterExperimentId_experiments_id_fk" FOREIGN KEY ("startAfterExperimentId") REFERENCES "public"."experiments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_holdout_percentage_range" CHECK ("projects"."holdout_percentage" >= 0 AND "projects"."holdout_percentage" <= 100);