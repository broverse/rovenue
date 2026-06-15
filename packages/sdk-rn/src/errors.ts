// Error class hierarchy mirroring Kotlin M4's RovenueException sealed
// class. Native impl rejects Nitro promises with `code: <variant>`;
// mapNativeError picks the right class.
//
// Why 13 classes instead of one error with a code field: enables
// `try { ... } catch (e) { if (e instanceof InsufficientCreditsError)
// { show e.available } }` — typed access to per-variant extras without
// runtime code switches in user code.

export class RovenueError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RovenueError";
    this.code = code;
    // Preserve prototype chain when transpiled to ES5 (no-op on ES2020).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidApiKeyError extends RovenueError {
  constructor(message: string) { super("InvalidApiKey", message); this.name = "InvalidApiKeyError"; }
}
export class NotConfiguredError extends RovenueError {
  constructor(message: string) { super("NotConfigured", message); this.name = "NotConfiguredError"; }
}
export class NetworkUnavailableError extends RovenueError {
  constructor(message: string) { super("NetworkUnavailable", message); this.name = "NetworkUnavailableError"; }
}
export class TimeoutError extends RovenueError {
  constructor(message: string) { super("Timeout", message); this.name = "TimeoutError"; }
}
export class RateLimitedError extends RovenueError {
  readonly retryAfter: number | null;
  constructor(message: string, retryAfter: number | null = null) {
    super("RateLimited", message);
    this.name = "RateLimitedError";
    this.retryAfter = retryAfter;
  }
}
export class ServerError extends RovenueError {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null = null) {
    super("Server", message);
    this.name = "ServerError";
    this.httpStatus = httpStatus;
  }
}
export class StorageError extends RovenueError {
  constructor(message: string) { super("Storage", message); this.name = "StorageError"; }
}
export class UserNotFoundError extends RovenueError {
  constructor(message: string) { super("UserNotFound", message); this.name = "UserNotFoundError"; }
}
export class InsufficientCreditsError extends RovenueError {
  readonly available: number;
  constructor(message: string, available: number = 0) {
    super("InsufficientCredits", message);
    this.name = "InsufficientCreditsError";
    this.available = available;
  }
}
export class EntitlementInactiveError extends RovenueError {
  constructor(message: string) { super("EntitlementInactive", message); this.name = "EntitlementInactiveError"; }
}
export class DuplicatePurchaseError extends RovenueError {
  constructor(message: string) { super("DuplicatePurchase", message); this.name = "DuplicatePurchaseError"; }
}
export class ReceiptInvalidError extends RovenueError {
  constructor(message: string) { super("ReceiptInvalid", message); this.name = "ReceiptInvalidError"; }
}
export class PurchaseCancelledError extends RovenueError {
  constructor(message: string) { super("PurchaseCancelled", message); this.name = "PurchaseCancelledError"; }
}
export class PurchasePendingError extends RovenueError {
  constructor(message: string) { super("PurchasePending", message); this.name = "PurchasePendingError"; }
}
export class ProductNotAvailableError extends RovenueError {
  constructor(message: string) { super("ProductNotAvailable", message); this.name = "ProductNotAvailableError"; }
}
export class StoreProblemError extends RovenueError {
  constructor(message: string) { super("StoreProblem", message); this.name = "StoreProblemError"; }
}
export class InternalError extends RovenueError {
  constructor(message: string) { super("Internal", message); this.name = "InternalError"; }
}

type Extras = { available?: number; retryAfter?: number; httpStatus?: number };

export function mapNativeError(code: string, message: string, extras?: Extras): RovenueError {
  switch (code) {
    case "InvalidApiKey":         return new InvalidApiKeyError(message);
    case "NotConfigured":         return new NotConfiguredError(message);
    case "NetworkUnavailable":    return new NetworkUnavailableError(message);
    case "Timeout":               return new TimeoutError(message);
    case "RateLimited":           return new RateLimitedError(message, extras?.retryAfter ?? null);
    case "Server":                return new ServerError(message, extras?.httpStatus ?? null);
    case "Storage":               return new StorageError(message);
    case "UserNotFound":          return new UserNotFoundError(message);
    case "InsufficientCredits":   return new InsufficientCreditsError(message, extras?.available ?? 0);
    case "EntitlementInactive":   return new EntitlementInactiveError(message);
    case "DuplicatePurchase":     return new DuplicatePurchaseError(message);
    case "ReceiptInvalid":        return new ReceiptInvalidError(message);
    case "PurchaseCancelled":     return new PurchaseCancelledError(message);
    case "PurchasePending":       return new PurchasePendingError(message);
    case "ProductNotAvailable":   return new ProductNotAvailableError(message);
    case "StoreProblem":          return new StoreProblemError(message);
    case "Internal":              return new InternalError(message);
    default:                      return new InternalError(message);
  }
}
