import { describe, expect, it } from "vitest";
import { RovenueError, mapNativeError, ERROR_KINDS, NATIVE_ERROR_ENVELOPE_PREFIX } from "../errors";

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

  // The Expo JSI bridge only forwards `code` + `message` to JS (no userInfo /
  // extras channel survives on either platform). Native therefore folds the
  // extras into the message as a tagged JSON envelope; mapNativeError unpacks it.
  describe("native message envelope", () => {
    const envelope = (obj: unknown) => NATIVE_ERROR_ENVELOPE_PREFIX + JSON.stringify(obj);

    it("extracts message + extras from a tagged envelope (extras arg empty)", () => {
      const e = mapNativeError(
        "RATE_LIMITED",
        envelope({ message: "slow down", serverCode: "RATE_LIMITED", httpStatus: 429, retryable: true, retryAfter: 12 }),
        {}, // bridge delivered nothing in extras — must not be relied on
      );
      expect(e.kind).toBe("RateLimited");
      expect(e.message).toBe("slow down");
      expect(e.serverCode).toBe("RATE_LIMITED");
      expect(e.httpStatus).toBe(429);
      expect(e.isRetryable).toBe(true);
      expect(e.data?.retryAfter).toBe(12);
    });

    it("leaves a plain (non-envelope) message untouched", () => {
      const e = mapNativeError("Forbidden", "no access", { serverCode: "FORBIDDEN", httpStatus: 403 });
      expect(e.message).toBe("no access");
      expect(e.serverCode).toBe("FORBIDDEN");
      expect(e.httpStatus).toBe(403);
    });

    it("falls back to the raw message when the envelope JSON is malformed", () => {
      const raw = NATIVE_ERROR_ENVELOPE_PREFIX + "{not json";
      const e = mapNativeError("Internal", raw, {});
      expect(e.message).toBe(raw);
    });
  });
});
