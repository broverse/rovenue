import { describe, expect, it } from "vitest";
import { RovenueError, mapNativeError, ERROR_KINDS } from "../errors";

describe("RN unified error", () => {
  it("maps a known kind with carried fields", () => {
    const e = mapNativeError("Forbidden", "no access",
      { serverCode: "FORBIDDEN", httpStatus: 403, retryable: false });
    expect(e).toBeInstanceOf(RovenueError);
    expect(e.kind).toBe("Forbidden");
    expect(e.serverCode).toBe("FORBIDDEN");
    expect(e.httpStatus).toBe(403);
    expect(e.isRetryable).toBe(false);
  });

  it("preserves serverCode even for an unknown kind", () => {
    const e = mapNativeError("SomethingNew", "msg", { serverCode: "X" });
    expect(e.kind).toBe("Internal");      // normalized fallback
    expect(e.serverCode).toBe("X");        // but nothing lost
  });

  it("derives isRetryable from kind when native omits it", () => {
    expect(mapNativeError("Timeout", "t", {}).isRetryable).toBe(true);
  });

  it("normalizes UPPER_SNAKE (Android casing) to PascalCase", () => {
    const e = mapNativeError("NETWORK_UNAVAILABLE", "no net", {});
    expect(e.kind).toBe("NetworkUnavailable");
    expect(e.isRetryable).toBe(true);
  });

  it("normalizes camelCase (iOS casing) to PascalCase", () => {
    const e = mapNativeError("networkUnavailable", "no net", {});
    expect(e.kind).toBe("NetworkUnavailable");
    expect(e.isRetryable).toBe(true);
  });

  it("ERROR_KINDS has exactly 24 entries", () => {
    expect(ERROR_KINDS.length).toBe(24);
  });

  it("carries available and retryAfter in data", () => {
    const e = mapNativeError("InsufficientCredits", "not enough",
      { available: 5, retryAfter: 30 });
    expect(e.data?.available).toBe(5);
    expect(e.data?.retryAfter).toBe(30);
  });
});
