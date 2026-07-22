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
  APPLE_OFFER_SIGNING_UNAVAILABLE: "apple_offer_signing_unavailable",
  APPLE_OFFER_SIGNING_FAILED: "apple_offer_signing_failed",
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
