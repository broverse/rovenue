ALTER TABLE "webhook_events"
  ADD COLUMN "claimedAt" timestamptz;

CREATE INDEX "webhook_events_status_claimedAt_idx"
  ON "webhook_events" ("status", "claimedAt");
