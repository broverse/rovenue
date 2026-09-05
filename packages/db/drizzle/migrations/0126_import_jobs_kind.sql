-- An enrichment import is a different operation from a history import:
-- it creates no purchases, accepts no mapping in the normal sense, and
-- has its own required-field set. Modelling it as a variant of the
-- history import is what made the revenuecat_google_token preset
-- detectable-but-unimportable. See ROADMAP §11.
DO $$ BEGIN
  CREATE TYPE "ImportJobKind" AS ENUM ('HISTORY', 'GOOGLE_TOKEN_ENRICHMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- Every existing job is a history import; the default keeps them so and
-- keeps the column NOT NULL without a rewrite pass.
ALTER TABLE "import_jobs"
  ADD COLUMN IF NOT EXISTS "kind" "ImportJobKind" NOT NULL DEFAULT 'HISTORY';
