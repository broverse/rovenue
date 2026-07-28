-- 0096_paywall_preview_sessions.sql
--
-- P9 on-device preview: a dashboard user mints a short-lived, revocable
-- token that lets a physical device fetch the paywall's DRAFT
-- (`paywalls.builderConfig`) instead of the published snapshot that
-- `/v1/placements` normally serves. This table is the mint/lookup/
-- revoke ledger for those tokens — see
-- apps/api/src/lib/placement-resolution.ts (`hydrateDraftPaywall`) for
-- the sanctioned exception to the "never serve the draft" invariant.
--
-- Only `tokenHash` is stored, never the plaintext token — same
-- treatment as `personal_access_tokens`. `expiresAt` is short-lived by
-- design (minted per preview session); `revokedAt` lets the dashboard
-- kill a session early. `findActiveByHash` requires BOTH
-- `revokedAt IS NULL` and `expiresAt > now()`, so the expires index
-- exists for that lookup and for the eventual sweep of stale rows.

CREATE TABLE "paywall_preview_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "projectId" text NOT NULL,
  "paywallId" text NOT NULL,
  "tokenHash" text NOT NULL,
  "createdBy" text NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "revokedAt" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "paywall_preview_sessions"
  ADD CONSTRAINT "paywall_preview_sessions_projectId_projects_id_fk"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE cascade;

ALTER TABLE "paywall_preview_sessions"
  ADD CONSTRAINT "paywall_preview_sessions_paywallId_paywalls_id_fk"
  FOREIGN KEY ("paywallId") REFERENCES "paywalls"("id") ON DELETE cascade;

CREATE UNIQUE INDEX "paywall_preview_sessions_tokenHash_key"
  ON "paywall_preview_sessions" ("tokenHash");

CREATE INDEX "paywall_preview_sessions_expires_idx"
  ON "paywall_preview_sessions" ("expiresAt");
