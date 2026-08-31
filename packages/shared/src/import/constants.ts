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
 *
 * Task 10 fix round 1 (FIX 1): this limit gates the job-lifecycle
 * MUTATION routes (upload, mapping edits, dry-run/commit/resume/cancel)
 * only — see `IMPORT_STATUS_POLL_RATE_LIMIT_PER_MINUTE` below for the
 * separate, much larger budget the READ routes (list, status, report)
 * use. A dashboard's polling loop sharing THIS budget would burn it in
 * the first 10-15 seconds of any run.
 */
export const IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE = 5;

/**
 * Task 10 fix round 1 (FIX 1): a SEPARATE, much more generous budget for
 * the job-lifecycle READ routes (`GET /`, `GET /:id`, `GET /:id/report`)
 * — `GET /:id` in particular is the route the dashboard is meant to poll
 * while a dry-run/commit/verify is in flight (routes/dashboard/imports.ts's
 * module comment). Sized for a client polling as often as twice a
 * second (well above any sane dashboard poll interval, which is
 * expected to be several seconds) with headroom for more than one
 * browser tab/viewer on the same project — 120/min, i.e. a rolling
 * 60-second window with room for 2 req/s sustained.
 */
export const IMPORT_STATUS_POLL_RATE_LIMIT_PER_MINUTE = 120;

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

/**
 * Upper bound on how many distinct `(store, storeTransactionId)` keys the
 * dry-run planner (and, later, the writer) will hold in memory to detect
 * an in-file duplicate row (task-6 fix round 1, FIX 2 — flagged in
 * review: tracking every key for the whole run is unbounded, and at the
 * 2 GiB upload cap and realistic row sizes that is on the order of ten
 * million keys).
 *
 * Each tracked key is a short string (store name + a store transaction
 * id, typically well under 64 chars) plus V8's per-string and Set-entry
 * overhead — roughly 150-200 bytes all in. 2,000,000 keys bounds resident
 * memory for this one data structure to a few hundred MB even on a
 * worst-case file, while comfortably covering every realistic single
 * import (a multi-million-SUBSCRIBER migration's transaction count is
 * usually a low multiple of its subscriber count, not this cap's size).
 *
 * `duplicateInFile` detection is informational, not a correctness
 * guarantee this cap is allowed to break: the writer upserts on
 * `(store, storeTransactionId)` regardless, so a duplicate missed past
 * this cap costs a redundant upsert, never a wrong one. Past the cap,
 * tracking simply STOPS for new keys (never guesses via a lossy hash,
 * which could produce a false positive and wrongly skip a real row) and
 * the dry-run summary records that duplicate detection was disabled
 * partway through, rather than silently going quiet.
 */
export const IMPORT_DUPLICATE_TRACKING_MAX_KEYS = 2_000_000;
