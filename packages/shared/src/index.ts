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
  BEARER_REQUIRED: "BEARER_REQUIRED",
  INVALID_API_KEY: "INVALID_API_KEY",
  INVALID_API_KEY_FORMAT: "INVALID_API_KEY_FORMAT",
  API_KEY_KIND_MISMATCH: "API_KEY_KIND_MISMATCH",
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
} as const;
export type HeaderName = (typeof HEADER)[keyof typeof HEADER];

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
