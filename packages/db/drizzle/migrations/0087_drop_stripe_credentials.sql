-- Stripe Connect replaces per-project API keys. This is destructive and
-- irreversible: every project must reconnect via OAuth after deploy.
ALTER TABLE "projects" DROP COLUMN IF EXISTS "stripeCredentials";
