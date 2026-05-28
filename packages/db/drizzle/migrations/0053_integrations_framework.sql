CREATE TYPE "public"."IntegrationProvider" AS ENUM('META_CAPI', 'TIKTOK_EVENTS');--> statement-breakpoint
CREATE TYPE "public"."IntegrationDeliveryStatus" AS ENUM('pending', 'succeeded', 'failed', 'skipped', 'dead_letter');--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"provider_id" "IntegrationProvider" NOT NULL,
	"display_name" text NOT NULL,
	"credentials_cipher" text NOT NULL,
	"credentials_hint" text NOT NULL,
	"enabled_events" text[] DEFAULT '{}'::text[] NOT NULL,
	"event_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action_source" text DEFAULT 'app' NOT NULL,
	"test_event_code" text,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_error" text,
	"last_backfill_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_action_source_chk" CHECK (action_source IN ('app','website','system_generated'))
);
--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_project_provider_uidx"
  ON "integration_connections" ("project_id", "provider_id");
--> statement-breakpoint
CREATE INDEX "integration_connections_enabled_idx"
  ON "integration_connections" ("project_id") WHERE is_enabled = true;
--> statement-breakpoint
CREATE TABLE "integration_deliveries" (
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"project_id" text NOT NULL,
	"provider_id" "IntegrationProvider" NOT NULL,
	"outbox_event_id" text NOT NULL,
	"event_key" text NOT NULL,
	"provider_event" text,
	"status" "IntegrationDeliveryStatus" NOT NULL,
	"attempt" smallint DEFAULT 0 NOT NULL,
	"skip_reason" text,
	"http_status" smallint,
	"response_body" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE (created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX "integration_deliveries_dedupe_uidx"
  ON "integration_deliveries" ("connection_id", "outbox_event_id", "created_at");
--> statement-breakpoint
CREATE INDEX "integration_deliveries_connection_status_idx"
  ON "integration_deliveries" ("connection_id", "status", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "integration_deliveries_project_dead_letter_idx"
  ON "integration_deliveries" ("project_id", "created_at" DESC) WHERE status = 'dead_letter';
--> statement-breakpoint
SELECT partman.create_parent(
  p_parent_table => 'public.integration_deliveries',
  p_control => 'created_at',
  p_interval => '1 day',
  p_premake => 7
);
--> statement-breakpoint
UPDATE partman.part_config
   SET retention='30 days', retention_keep_table=false
 WHERE parent_table='public.integration_deliveries';
