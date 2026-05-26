CREATE TABLE "project_notification_defaults" (
	"projectId" text PRIMARY KEY NOT NULL,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"platform" "PushPlatform" NOT NULL,
	"token" text NOT NULL,
	"appBundleId" text NOT NULL,
	"locale" text NOT NULL,
	"timezone" text NOT NULL,
	"lastSeenAt" timestamp with time zone DEFAULT now() NOT NULL,
	"revokedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_project_notification_prefs" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"projectId" text NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_notification_defaults" ADD CONSTRAINT "project_notification_defaults_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_notification_prefs" ADD CONSTRAINT "user_project_notification_prefs_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_notification_prefs" ADD CONSTRAINT "user_project_notification_prefs_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_platform_token_key" ON "push_devices" USING btree ("platform","token");--> statement-breakpoint
CREATE INDEX "push_devices_userId_active_idx" ON "push_devices" USING btree ("userId") WHERE "revokedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_project_notification_prefs_userId_projectId_key" ON "user_project_notification_prefs" USING btree ("userId","projectId");--> statement-breakpoint
CREATE INDEX "user_project_notification_prefs_userId_idx" ON "user_project_notification_prefs" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "user_project_notification_prefs_projectId_idx" ON "user_project_notification_prefs" USING btree ("projectId");--> statement-breakpoint
-- Data migration: lift per-event toggles into user_project_notification_prefs.
-- IDs are deterministic ("mig-<userId>-<projectId>") so re-running the
-- migration on a partial restore is idempotent via the unique key.
INSERT INTO user_project_notification_prefs (id, "userId", "projectId", overrides)
SELECT
  'mig-' || pm."userId" || '-' || pm."projectId",
  pm."userId",
  pm."projectId",
  jsonb_build_object(
    'revenue.anomaly.detected',   COALESCE((up.notifications->>'anomaly')::boolean, true),
    'revenue.digest.daily',       COALESCE((up.notifications->>'daily_digest')::boolean, true),
    'revenue.digest.weekly',      COALESCE((up.notifications->>'weekly_summary')::boolean, true),
    'revenue.milestone.hit',      COALESCE((up.notifications->>'milestone')::boolean, false),
    'revenue.churn.spike',        COALESCE((up.notifications->>'churn_spike')::boolean, true),
    'billing.refund.detected',    COALESCE((up.notifications->>'refund_alert')::boolean, true),
    'billing.invoice.failed',     COALESCE((up.notifications->>'invoice')::boolean, true),
    'billing.credit.low_balance', COALESCE((up.notifications->>'low_balance')::boolean, true)
  )
FROM user_preferences up
JOIN project_members pm ON pm."userId" = up."userId"
ON CONFLICT ("userId", "projectId") DO NOTHING;
--> statement-breakpoint
-- Collapse user_preferences.notifications JSONB to the new shape.
UPDATE user_preferences SET notifications = jsonb_build_object(
  'channels', jsonb_build_object(
    'email', COALESCE((notifications->>'email')::boolean, true),
    'push',  COALESCE((notifications->>'push')::boolean, true)
  ),
  'muted_until', null
);