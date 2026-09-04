// =============================================================
// API response envelope
// =============================================================

export const ERROR_CODE = {
  HTTP_ERROR: "HTTP_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  RATE_LIMITED: "RATE_LIMITED",
  ROVI_NOT_CONFIGURED: "ROVI_NOT_CONFIGURED",
  ROVI_QUOTA_EXCEEDED: "ROVI_QUOTA_EXCEEDED",
  BEARER_REQUIRED: "BEARER_REQUIRED",
  INVALID_API_KEY: "INVALID_API_KEY",
  INVALID_API_KEY_FORMAT: "INVALID_API_KEY_FORMAT",
  API_KEY_KIND_MISMATCH: "API_KEY_KIND_MISMATCH",
  STORE_NOT_CONFIGURED: "STORE_NOT_CONFIGURED",
  STORE_API_ERROR: "STORE_API_ERROR",
  APP_STORE_LOOKUP_FAILED: "APP_STORE_LOOKUP_FAILED",
  APP_NOT_FOUND: "APP_NOT_FOUND",
  APPLE_OFFER_SIGNING_UNAVAILABLE: "apple_offer_signing_unavailable",
  APPLE_OFFER_SIGNING_FAILED: "apple_offer_signing_failed",
  GENERATION_INVALID: "GENERATION_INVALID",
  // Auto-translate (ROADMAP §3): the request itself is unusable — empty,
  // over the per-call cap, or asking to translate a locale into itself.
  // A model that produced BAD translations is NOT this: those keys come
  // back in `rejected` with a 200, because the good ones are still worth
  // applying.
  TRANSLATION_INVALID: "TRANSLATION_INVALID",
  // P9 on-device preview (§6.17): missing, expired, revoked, and garbage
  // preview tokens must be indistinguishable — this single code covers
  // all of them, always behind a generic 404 message (no oracle).
  PREVIEW_SESSION_INVALID: "PREVIEW_SESSION_INVALID",
  // Paywall fonts wave E1 (upload, design spec §3): magic-byte format
  // rejection, the hard per-face size cap, and the per-project face-count
  // cap are three distinct, machine-readable rejections a dashboard client
  // needs to tell apart. FONT_FAMILY_NOT_FOUND covers a client-supplied
  // familyId that does not resolve to a live family owned by the project
  // (missing, foreign, or soft-deleted) — see Task 1 review finding #2.
  FONT_FORMAT_UNSUPPORTED: "FONT_FORMAT_UNSUPPORTED",
  FONT_FILE_TOO_LARGE: "FONT_FILE_TOO_LARGE",
  FONT_QUOTA_EXCEEDED: "FONT_QUOTA_EXCEEDED",
  FONT_FAMILY_NOT_FOUND: "FONT_FAMILY_NOT_FOUND",
  // Paywall asset CDN (design spec §11). Six distinct machine-readable
  // rejections a dashboard client needs to tell apart — notably
  // ASSET_FILE_TOO_LARGE, which `bodyLimit`'s onError returns for the
  // transport-level rejection and the in-handler check returns for the
  // ordinary case, so a caller sees one code either way.
  ASSET_FORMAT_UNSUPPORTED: "ASSET_FORMAT_UNSUPPORTED",
  ASSET_FILE_TOO_LARGE: "ASSET_FILE_TOO_LARGE",
  ASSET_QUOTA_EXCEEDED: "ASSET_QUOTA_EXCEEDED",
  ASSET_STORAGE_UNAVAILABLE: "ASSET_STORAGE_UNAVAILABLE",
  ASSET_INVALID_NAME: "ASSET_INVALID_NAME",
  ASSET_PROCESSING_FAILED: "ASSET_PROCESSING_FAILED",
  // Asset referential integrity (2026-08-23 store-billing correctness,
  // Task 9). ASSET_IN_USE: DELETE refuses (409) to remove an asset still
  // referenced by a published paywall version or a draft builderConfig
  // unless `?force=true` — the S3 object is hard-deleted, so a stale
  // reference becomes a device-visible 404. ASSET_MISSING: publish
  // refuses (400) a tree referencing one of this project's asset URLs
  // whose row is soft-deleted or nonexistent; external URLs pass
  // untouched. Lowercase like PURCHASE_NOT_PAID — both ride
  // HTTPException.cause through middleware/error.ts.
  ASSET_IN_USE: "asset_in_use",
  ASSET_MISSING: "asset_missing",
  // Data-import tool (design spec §4, migration-import plan Task 5).
  // IMPORT_FILE_TOO_LARGE: `bodyLimit`'s onError for the upload route's
  // own cap — same pattern as ASSET_FILE_TOO_LARGE above. IMPORT_STORAGE_
  // UNAVAILABLE: the dedicated private import bucket (never the public
  // paywall-asset one — see lib/import-store.ts) is unconfigured or
  // unreachable.
  IMPORT_FILE_TOO_LARGE: "IMPORT_FILE_TOO_LARGE",
  IMPORT_STORAGE_UNAVAILABLE: "IMPORT_STORAGE_UNAVAILABLE",
  // Google Play receipt for a purchase the user has not (yet) paid for —
  // subscriptionState PENDING on subscriptions, purchaseState PENDING on
  // one-time products. The purchase may still complete: the client should
  // retry verification after payment finishes, so this is machine-readable
  // rather than folded into the generic 400 VALIDATION_ERROR.
  PURCHASE_NOT_PAID: "purchase_not_paid",
  // The root app's global request-body ceiling (apps/api/src/app.ts).
  // Distinct from the per-route *_FILE_TOO_LARGE codes above: those mean
  // "this upload is bigger than its own kind allows", this one means
  // "this endpoint accepts no body remotely this large at all". Without
  // it a breach surfaced as HTTP_ERROR with an EMPTY message, because
  // hono's `bodyLimit` throws an HTTPException carrying its text in a
  // `res` the error handler replaces rather than in `.message`.
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  // SDK-facing billing-portal session endpoint (store-integrations
  // completeness, Task 3). This is an auth surface — the URL it returns
  // grants access to payment data — so its failure modes are distinct
  // machine-readable codes rather than a generic 400/404.
  // STRIPE_NOT_CONNECTED: the project has no active Stripe Connect
  // account to open a portal session on. STRIPE_CUSTOMER_NOT_FOUND: the
  // authenticated subscriber has no Stripe customer on record — the
  // normal case for an Apple/Google-only subscriber, not an error state.
  // RETURN_URL_NOT_ALLOWED: `returnUrl` is not one of the project's
  // verified domains; the request's URL is never echoed back unchecked.
  STRIPE_NOT_CONNECTED: "STRIPE_NOT_CONNECTED",
  STRIPE_CUSTOMER_NOT_FOUND: "STRIPE_CUSTOMER_NOT_FOUND",
  RETURN_URL_NOT_ALLOWED: "RETURN_URL_NOT_ALLOWED",
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

export type ApiResponse<T> =
  | { data: T }
  | { error: { code: ErrorCode; message: string } };

// =============================================================
// API key kinds and prefixes (shared between api and sdk)
// =============================================================

export const API_KEY_KIND = {
  PUBLIC: "PUBLIC",
  SECRET: "SECRET",
} as const;
export type ApiKeyKind = (typeof API_KEY_KIND)[keyof typeof API_KEY_KIND];

export const API_KEY_PREFIX = {
  [API_KEY_KIND.PUBLIC]: "rov_pub_",
  [API_KEY_KIND.SECRET]: "rov_sec_",
} as const satisfies Record<ApiKeyKind, string>;

// =============================================================
// HTTP header names
// =============================================================

export const HEADER = {
  AUTHORIZATION: "authorization",
  X_API_KEY: "x-api-key",
  X_FORWARDED_FOR: "x-forwarded-for",
  X_RATE_LIMIT_LIMIT: "X-RateLimit-Limit",
  X_RATE_LIMIT_REMAINING: "X-RateLimit-Remaining",
  X_ROVENUE_APP_USER_ID: "x-rovenue-app-user-id",
  // First-install platform reported by the SDK on the create-triggering
  // request. Persisted once (create-only) as the `platform` attribute.
  X_ROVENUE_PLATFORM: "x-rovenue-platform",
} as const;
export type HeaderName = (typeof HEADER)[keyof typeof HEADER];

/** Platforms the SDK may report via {@link HEADER.X_ROVENUE_PLATFORM}. */
export const SDK_PLATFORMS = ["ios", "android", "web"] as const;
export type SdkPlatform = (typeof SDK_PLATFORMS)[number];

/** Narrows an arbitrary header value to a known {@link SdkPlatform}. */
export function parseSdkPlatform(
  raw: string | undefined | null,
): SdkPlatform | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  return (SDK_PLATFORMS as ReadonlyArray<string>).includes(v)
    ? (v as SdkPlatform)
    : undefined;
}

export const BEARER_SCHEME = "Bearer";

// =============================================================
// Subscription lifecycle
// =============================================================

export const SUBSCRIPTION_STATE = {
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  GRACE_PERIOD: "GRACE_PERIOD",
  EXPIRED: "EXPIRED",
  PAUSED: "PAUSED",
  REFUNDED: "REFUNDED",
} as const;
export type SubscriptionState =
  (typeof SUBSCRIPTION_STATE)[keyof typeof SUBSCRIPTION_STATE];

// =============================================================
// Logger factory
// =============================================================

export * from "./logger";

// =============================================================
// AES-256-GCM encryption utility
// =============================================================

// `./crypto` is intentionally NOT re-exported here — it depends on
// `node:crypto` and would crash the dashboard Vite bundle. Server-side
// callers import it explicitly via `@rovenue/shared/crypto`.

// =============================================================
// Experiments — types (Flag / ProductGroup / Paywall / Element),
// bucketing primitives, and audience targeting
// =============================================================

// Only re-export the experiment Zod types + constants here. The runtime
// bucketing / audience-targeting helpers depend on `node:crypto` and
// must not be pulled into the dashboard's browser bundle — server
// callers import them via `@rovenue/shared/experiments`.
export * from "./experiments/types";

// =============================================================
// Placements — row schema and targeting
// =============================================================

export * from "./placements";

// =============================================================
// Dashboard API request/response types
// =============================================================

export * from "./dashboard";

// =============================================================
// Billing — dashboard wire types (Phase 2)
// =============================================================

export * from "./billing";

// =============================================================
// Store commission-rate presets (single source of truth — see
// commission-rates.ts's header). apps/api's proceeds.ts re-exports
// these rather than declaring its own copy.
// =============================================================

export * from "./commission-rates";

// =============================================================
// Onboarding funnel — page/branching/settings Zod schemas
// =============================================================

export * from "./funnel";

// =============================================================
// Paywall builder — node-tree schema, validator, and variable
// resolution (dashboard visual builder + web renderer)
// =============================================================

export * from "./paywall";

// =============================================================
// Subscriber attributes — types, catalog, and helpers
// =============================================================

export * from "./attributes";

// =============================================================
// Currency utilities — Stripe minor-unit scaling and conversion
// =============================================================

export { stripeMinorUnitExponent, decimalToMinorUnits } from "./currency";

// =============================================================
// Copilot — types, tier limits, and intent handling
// =============================================================

export * from "./copilot";

// =============================================================
// Integrations — canonical event keys and provider types
// =============================================================

export * from "./integrations";

// =============================================================
// i18n primitives — reusable by funnel + paywall builders
// =============================================================
export type { Localized, LocaleCode, LocaleSet } from "./i18n";
export { pick, expand, isLocalized, liftToLocalized, mapLocalizedFields } from "./i18n";

export * from "./webhook-events";

// =============================================================
// Store-native lifecycle -> public RovenueEventKey normalization
// (Wave-1, narrow — see store-event-normalization.ts for scope)
// =============================================================

export * from "./store-event-normalization";

// =============================================================
// Paywall fonts — format detection and constants
// =============================================================

export * from "./fonts";

// =============================================================
// Paywall assets — kind detection, name validation, and caps
// =============================================================

export * from "./assets";

// =============================================================
// Data import — canonical row contract, streaming CSV parser,
// preset detection, mapping validation, and the row normalizer
// (RevenueCat/Adapty subscriber-history import)
// =============================================================

// `./import`'s own barrel (src/import/index.ts) deliberately excludes
// `./import/keys` — it depends on `node:crypto` and would crash the
// dashboard Vite bundle the same way `./crypto` and the experiments
// bucketing helpers would. Server-side callers import it explicitly via
// `@rovenue/shared/import/keys`.
export * from "./import";
