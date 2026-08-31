// =============================================================
// Data-import tool — the numbers, in one place
// =============================================================
//
// Mirrors packages/shared/src/assets/constants.ts's convention: every
// cap this feature enforces lives here so a reviewer can see the whole
// envelope at once, and so no route or worker ever hard-codes one of
// them.

/**
 * Hard cap on a single upload's raw body size, enforced by the upload
 * route's own `hono/body-limit` registration (routes/dashboard/imports.ts) —
 * the same "route binds its OWN cap" pattern `ASSET_MAX_BYTES` documents,
 * and for the same reason: the root app's global 1 MiB body limit would
 * otherwise shadow it (see apps/api/src/app.ts's `ROUTE_OWNED_BODY_LIMIT_PATH`).
 *
 * 2 GiB (raised from an initial 500 MiB — task-6 controller context,
 * carried-forward item 1): the design spec itself says a real export can
 * run into the gigabytes, and the route already streams the body straight
 * to object storage while hashing (never buffers it whole), so nothing
 * about the implementation caps out earlier than this number does.
 *
 * A cap is only as real as the layer in front of it. Checked at the same
 * time this was raised: `deploy/caddy/Caddyfile` (the edge proxy in front
 * of `api:3000` in every deploy topology this repo ships) sets no
 * `request_body { max_size ... }` directive anywhere, so Caddy imposes NO
 * body-size ceiling of its own on this path — the app's own bodyLimit
 * registration below is the only limit an upload actually hits. Had Caddy
 * capped the request body lower than this constant, that lower number
 * would need to be the real value here instead: a larger app-level cap
 * behind a smaller proxy cap fails silently as a truncated/reset upload,
 * which is the same class of bug `apps/api/src/app.ts`'s
 * `ROUTE_OWNED_BODY_LIMIT_PATH` comment already documents for the
 * global-vs-route-owned `bodyLimit` shadowing incident.
 */
export const IMPORT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Upload is a rare, heavy, whole-project operation (one-time history
 * migration), not routine traffic — stricter than
 * `ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE` (20) on purpose.
 */
export const IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE = 5;

/**
 * Uploaded files are end-user PII (design spec §4). Once a job reaches a
 * terminal status, its object is deleted after this many days rather
 * than kept indefinitely — matching the GDPR-tier treatment the rest of
 * this capability gets (see capabilities.ts's `subscribers:import`
 * comment).
 */
export const IMPORT_FILE_RETENTION_DAYS = 7;

/** Key prefix every import upload/report object is stored under, in the
 *  DEDICATED, PRIVATE import bucket (never the public paywall-asset
 *  bucket — see apps/api/src/lib/import-store.ts's module comment for
 *  why those must never share a bucket). */
export const IMPORT_STORAGE_PREFIX = "imports";
