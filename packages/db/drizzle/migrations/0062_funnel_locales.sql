-- Add BCP47 locale config to funnels: default_locale + locales[].
-- The renderer falls back to default_locale whenever a string is
-- missing for the active locale. Both are draft-side; published
-- versions snapshot the value at publish time.
ALTER TABLE "funnels" ADD COLUMN "default_locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "funnels" ADD COLUMN "locales" jsonb DEFAULT '["en"]'::jsonb NOT NULL;
