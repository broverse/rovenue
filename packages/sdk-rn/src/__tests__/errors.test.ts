import { describe, expect, it } from "vitest";
import {
  RovenueError,
  InvalidApiKeyError,
  NotConfiguredError,
  NetworkUnavailableError,
  TimeoutError,
  RateLimitedError,
  ServerError,
  StorageError,
  UserNotFoundError,
  InsufficientCreditsError,
  EntitlementInactiveError,
  DuplicatePurchaseError,
  ReceiptInvalidError,
  InternalError,
  PurchaseCancelledError,
  PurchasePendingError,
  ProductNotAvailableError,
  StoreProblemError,
  mapNativeError,
} from "../errors";

describe("Rovenue error classes", () => {
  it("all 13 subclasses extend RovenueError", () => {
    const cases: Array<[new (m: string) => RovenueError, string]> = [
      [InvalidApiKeyError, "InvalidApiKey"],
      [NotConfiguredError, "NotConfigured"],
      [NetworkUnavailableError, "NetworkUnavailable"],
      [TimeoutError, "Timeout"],
      [RateLimitedError, "RateLimited"],
      [ServerError, "Server"],
      [StorageError, "Storage"],
      [UserNotFoundError, "UserNotFound"],
      [InsufficientCreditsError, "InsufficientCredits"],
      [EntitlementInactiveError, "EntitlementInactive"],
      [DuplicatePurchaseError, "DuplicatePurchase"],
      [ReceiptInvalidError, "ReceiptInvalid"],
      [InternalError, "Internal"],
    ];
    for (const [Ctor, code] of cases) {
      const e = new Ctor("test message");
      expect(e).toBeInstanceOf(RovenueError);
      expect(e).toBeInstanceOf(Ctor);
      expect(e.code).toBe(code);
      expect(e.message).toBe("test message");
    }
  });

  it("mapNativeError picks the right class by code", () => {
    expect(mapNativeError("InvalidApiKey", "x")).toBeInstanceOf(InvalidApiKeyError);
    expect(mapNativeError("InsufficientCredits", "x", { available: 3 })).toBeInstanceOf(
      InsufficientCreditsError,
    );
    expect(mapNativeError("RateLimited", "x", { retryAfter: 30 })).toBeInstanceOf(
      RateLimitedError,
    );
  });

  it("mapNativeError falls back to InternalError for unknown codes", () => {
    const e = mapNativeError("UnknownCode", "huh");
    expect(e).toBeInstanceOf(InternalError);
    expect(e.message).toBe("huh");
  });

  it("InsufficientCreditsError preserves available extra", () => {
    const e = mapNativeError("InsufficientCredits", "not enough", { available: 3 });
    expect((e as InsufficientCreditsError).available).toBe(3);
  });

  it("RateLimitedError preserves retryAfter extra (null when missing)", () => {
    const e1 = mapNativeError("RateLimited", "slow down", { retryAfter: 30 });
    expect((e1 as RateLimitedError).retryAfter).toBe(30);
    const e2 = mapNativeError("RateLimited", "slow down");
    expect((e2 as RateLimitedError).retryAfter).toBeNull();
  });

  it("ServerError preserves httpStatus extra (null when missing)", () => {
    const e = mapNativeError("Server", "boom", { httpStatus: 503 });
    expect((e as ServerError).httpStatus).toBe(503);
  });

  it("purchase-flow error classes extend RovenueError with correct codes", () => {
    expect(new PurchaseCancelledError("x")).toBeInstanceOf(RovenueError);
    expect(new PurchaseCancelledError("x").code).toBe("PurchaseCancelled");
    expect(new PurchasePendingError("x")).toBeInstanceOf(RovenueError);
    expect(new PurchasePendingError("x").code).toBe("PurchasePending");
    expect(new ProductNotAvailableError("x")).toBeInstanceOf(RovenueError);
    expect(new ProductNotAvailableError("x").code).toBe("ProductNotAvailable");
    expect(new StoreProblemError("x")).toBeInstanceOf(RovenueError);
    expect(new StoreProblemError("x").code).toBe("StoreProblem");
  });

  it("mapNativeError maps purchase-flow codes to correct classes", () => {
    expect(mapNativeError("PurchaseCancelled", "x")).toBeInstanceOf(PurchaseCancelledError);
    expect(mapNativeError("PurchasePending", "x")).toBeInstanceOf(PurchasePendingError);
    expect(mapNativeError("ProductNotAvailable", "x")).toBeInstanceOf(ProductNotAvailableError);
    expect(mapNativeError("StoreProblem", "x")).toBeInstanceOf(StoreProblemError);
  });
});
