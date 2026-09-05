CREATE TYPE "public"."CurrencyGrantTrigger" AS ENUM('PURCHASE', 'RENEWAL', 'BOTH');--> statement-breakpoint
CREATE TYPE "public"."LeaderboardCadence" AS ENUM('WEEKLY', 'MONTHLY', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."LeaderboardMetric" AS ENUM('TOP_SPENDERS', 'TOP_CONSUMERS');--> statement-breakpoint
CREATE TYPE "public"."LeaderboardSeasonStatus" AS ENUM('ACTIVE', 'CLOSED');--> statement-breakpoint
CREATE TABLE "leaderboard_seasons" (
	"id" text PRIMARY KEY NOT NULL,
	"leaderboardId" text NOT NULL,
	"seasonNumber" integer NOT NULL,
	"startsAt" timestamp with time zone NOT NULL,
	"endsAt" timestamp with time zone NOT NULL,
	"status" "LeaderboardSeasonStatus" DEFAULT 'ACTIVE' NOT NULL,
	"closedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboard_standings" (
	"id" text PRIMARY KEY NOT NULL,
	"seasonId" text NOT NULL,
	"rank" integer NOT NULL,
	"subscriberId" text NOT NULL,
	"score" text NOT NULL,
	"eventCount" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboards" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"metric" "LeaderboardMetric" NOT NULL,
	"currencyId" text,
	"cadence" "LeaderboardCadence" NOT NULL,
	"customPeriodDays" integer,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"entryLimit" integer DEFAULT 100 NOT NULL,
	"anchorAt" timestamp with time zone NOT NULL,
	"isEnabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_currency_grants" ADD COLUMN "grantOn" "CurrencyGrantTrigger" DEFAULT 'PURCHASE' NOT NULL;--> statement-breakpoint
ALTER TABLE "leaderboard_seasons" ADD CONSTRAINT "leaderboard_seasons_leaderboardId_leaderboards_id_fk" FOREIGN KEY ("leaderboardId") REFERENCES "public"."leaderboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_standings" ADD CONSTRAINT "leaderboard_standings_seasonId_leaderboard_seasons_id_fk" FOREIGN KEY ("seasonId") REFERENCES "public"."leaderboard_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboards" ADD CONSTRAINT "leaderboards_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboards" ADD CONSTRAINT "leaderboards_currencyId_virtual_currencies_id_fk" FOREIGN KEY ("currencyId") REFERENCES "public"."virtual_currencies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leaderboard_seasons_leaderboardId_seasonNumber_key" ON "leaderboard_seasons" USING btree ("leaderboardId","seasonNumber");--> statement-breakpoint
CREATE INDEX "leaderboard_seasons_status_endsAt_idx" ON "leaderboard_seasons" USING btree ("status","endsAt");--> statement-breakpoint
CREATE UNIQUE INDEX "leaderboard_standings_seasonId_rank_key" ON "leaderboard_standings" USING btree ("seasonId","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "leaderboards_projectId_identifier_key" ON "leaderboards" USING btree ("projectId","identifier");--> statement-breakpoint
CREATE INDEX "leaderboards_projectId_idx" ON "leaderboards" USING btree ("projectId");--> statement-breakpoint
-- At most one ACTIVE season per leaderboard. This constraint is what makes
-- "two replicas open two live seasons" a database error instead of a data
-- corruption, with no application-level locking.
CREATE UNIQUE INDEX "leaderboard_seasons_one_active_idx"
  ON "leaderboard_seasons" ("leaderboardId")
  WHERE "status" = 'ACTIVE';
--> statement-breakpoint
-- customPeriodDays is required for CUSTOM and forbidden otherwise.
ALTER TABLE "leaderboards" ADD CONSTRAINT "leaderboards_custom_period_days_check"
  CHECK (
    ("cadence" = 'CUSTOM' AND "customPeriodDays" IS NOT NULL AND "customPeriodDays" > 0)
    OR ("cadence" <> 'CUSTOM' AND "customPeriodDays" IS NULL)
  );
