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
 * 500 MiB comfortably covers a multi-million-row RevenueCat Transactions
 * export (each row is a few hundred bytes) while staying a bounded,
 * defensible ceiling for a raw-body HTTP upload rather than an unbounded
 * one. Streamed to object storage while hashing, never buffered whole.
 */
export const IMPORT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

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
