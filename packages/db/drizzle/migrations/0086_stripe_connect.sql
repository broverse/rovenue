-- Stripe Connect: one active connected account per project.
-- OAuth tokens are intentionally not stored (direct charges need only
-- the account id plus the platform key).

CREATE TABLE IF NOT EXISTS "project_stripe_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "stripe_account_id" text NOT NULL,
  "livemode" boolean NOT NULL,
  "scope" text NOT NULL,
  "charges_enabled" boolean NOT NULL DEFAULT false,
  "payouts_enabled" boolean NOT NULL DEFAULT false,
  "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "country" text,
  "default_currency" text,
  "connected_at" timestamptz NOT NULL DEFAULT now(),
  "connected_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "disconnected_at" timestamptz,
  "disconnect_reason" text,
  "last_synced_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_stripe_connections_active_uq"
  ON "project_stripe_connections" ("project_id")
  WHERE "disconnected_at" IS NULL;

CREATE INDEX IF NOT EXISTS "project_stripe_connections_account_idx"
  ON "project_stripe_connections" ("stripe_account_id");
