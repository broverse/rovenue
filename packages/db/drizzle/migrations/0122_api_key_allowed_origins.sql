-- Browser origins permitted to use this API key.
--
-- Empty means the key is NOT enabled for browser use. That is why the
-- default is '{}' and why there is no backfill: every key that predates the
-- Web SDK keeps working exactly as before for native callers, and none of
-- them silently becomes usable from a web page.
--
-- Origins are matched exactly (scheme + host + port). No wildcards: a
-- "https://*.example.com" entry would turn a subdomain takeover into an API
-- key. The dashboard and the API validate entries with one shared parser.
--
-- The column exists because a CORS preflight carries no Authorization
-- header, so the server cannot resolve the project from the Bearer key at
-- the moment it must decide the origin -- the allow-list has to be
-- reachable from the public key alone.
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "allowedOrigins" text[] NOT NULL DEFAULT '{}';
