-- 0049_user_known_devices.sql
-- Per-user device fingerprint registry used by the
-- security.signin.new_device notification producer.
--
-- Fingerprint is SHA-256(userAgent + ipAddress) — opaque to
-- the consumer; we only care about "have we seen this before".
-- (userId, fingerprint) is unique so the upsert can use
-- ON CONFLICT to detect new vs returning devices.

CREATE TABLE "user_known_devices" (
  "id" text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "fingerprint" text NOT NULL,
  "lastSeenAt" timestamp with time zone NOT NULL DEFAULT now(),
  "createdAt" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX "user_known_devices_userId_fingerprint_key"
  ON "user_known_devices" ("userId", "fingerprint");--> statement-breakpoint

CREATE INDEX "user_known_devices_userId_idx"
  ON "user_known_devices" ("userId");
