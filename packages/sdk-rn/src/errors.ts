// Single-class error surface for the Rovenue RN SDK.
//
// Every failure from native (iOS/Android) is surfaced as a RovenueError with
// a `kind: ErrorKind` discriminant. The 24 canonical PascalCase kinds match
// the Rust UDL definitions; the JS normalizer absorbs the three casings that
// the native bridges emit:
//
//   iOS bridge   → String(describing: error.kind) = camelCase  "networkUnavailable"
//   Android bridge → error.kind.name               = UPPER_SNAKE "NETWORK_UNAVAILABLE"
//   Direct JS    → PascalCase                                   "NetworkUnavailable"
//
// All three land in mapNativeError() which strips underscores and does a
// case-insensitive compare to resolve the canonical kind.

export const ERROR_KINDS = [
  "NetworkUnavailable",
  "Timeout",
  "RateLimited",
  "ServerError",
  "InvalidApiKey",
  "Forbidden",
  "NotFound",
  "InvalidRequest",
  "Conflict",
  "InvalidArgument",
  "InsufficientCredits",
  "FunnelTokenNotFound",
  "FunnelTokenExpired",
  "FunnelTokenAlreadyClaimed",
  "PurchaseCanceled",
  "ProductNotAvailable",
  "AlreadyOwned",
  "PaymentDeclined",
  "StoreServiceUnavailable",
  "Ineligible",
  "ReceiptInvalid",
  "StoreProblem",
  "Storage",
  "Internal",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

// Pre-compute lowercase-no-underscore lookup table once at module load.
// Maps stripped-lowercase → canonical PascalCase kind.
const KIND_LOOKUP = new Map<string, ErrorKind>(
  ERROR_KINDS.map((k) => [k.toLowerCase().replace(/_/g, ""), k]),
);

const RETRYABLE = new Set<ErrorKind>([
  "NetworkUnavailable",
  "Timeout",
  "RateLimited",
  "ServerError",
  "StoreServiceUnavailable",
]);

export interface ErrorExtras {
  serverCode?: string;
  httpStatus?: number;
  retryable?: boolean;
  available?: number;
  retryAfter?: number;
}

export class RovenueError extends Error {
  readonly kind: ErrorKind;
  readonly serverCode?: string;
  readonly httpStatus?: number;
  readonly isRetryable: boolean;
  /** Carries per-kind payload: `available` for InsufficientCredits, `retryAfter` for RateLimited. */
  readonly data?: { available?: number; retryAfter?: number };

  constructor(kind: ErrorKind, message: string, extras: ErrorExtras = {}) {
    super(message);
    this.name = "RovenueError";
    // Preserve prototype chain when transpiled to ES5.
    Object.setPrototypeOf(this, RovenueError.prototype);
    this.kind = kind;
    this.serverCode = extras.serverCode;
    this.httpStatus = extras.httpStatus;
    this.isRetryable = extras.retryable ?? RETRYABLE.has(kind);
    if (extras.available !== undefined || extras.retryAfter !== undefined) {
      this.data = { available: extras.available, retryAfter: extras.retryAfter };
    }
  }
}

/**
 * Normalize a native-bridge error code to a canonical `ErrorKind`.
 *
 * Accepts all three casings that the native layers emit:
 *  - PascalCase  "NetworkUnavailable"  (RN canonical / direct JS)
 *  - camelCase   "networkUnavailable"  (iOS — `String(describing: error.kind)`)
 *  - UPPER_SNAKE "NETWORK_UNAVAILABLE" (Android — `error.kind.name`)
 *
 * Strategy: strip underscores, lowercase, look up in the precomputed table.
 * Unknown codes fall back to "Internal" while still preserving serverCode/
 * message/extras so nothing is lost.
 */
function normalizeKind(code: string): ErrorKind {
  const key = code.toLowerCase().replace(/_/g, "");
  return KIND_LOOKUP.get(key) ?? "Internal";
}

/**
 * Tag that marks a native error `message` as a JSON extras-envelope.
 *
 * The Expo JSI bridge forwards ONLY `code` + `message` to JS — neither the iOS
 * `userInfo` nor the Android `CodedException` cause/extras survive the crossing
 * (iOS `makeCodedError(code, message)`; Android `PromiseImpl.reject` →
 * `callback.invoke(code, message)`). So the native bridges fold the structured
 * extras INTO the message as `PREFIX + JSON({ message, serverCode, httpStatus,
 * retryable, available, retryAfter })`, and we unpack them back out here. Kept
 * in sync verbatim with RovenueModule.swift / RovenueModule.kt.
 */
export const NATIVE_ERROR_ENVELOPE_PREFIX = "@rovenue/err1:";

export function mapNativeError(
  code: string,
  message: string,
  extras: ErrorExtras = {},
): RovenueError {
  const kind = normalizeKind(code);
  let realMessage = message;
  let realExtras = extras;
  if (typeof message === "string" && message.startsWith(NATIVE_ERROR_ENVELOPE_PREFIX)) {
    try {
      const env = JSON.parse(message.slice(NATIVE_ERROR_ENVELOPE_PREFIX.length));
      realMessage = typeof env.message === "string" ? env.message : "";
      realExtras = {
        serverCode: env.serverCode,
        httpStatus: env.httpStatus,
        retryable: env.retryable,
        available: env.available,
        retryAfter: env.retryAfter,
      };
    } catch {
      // Malformed envelope — surface the raw message rather than throwing.
    }
  }
  return new RovenueError(kind, realMessage, realExtras);
}
