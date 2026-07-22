import { describe, expect, it } from "vitest";
import { ApiError } from "../../../lib/api";
import { isPaywallInUse } from "../paywall-errors";

describe("isPaywallInUse", () => {
  it("detects the PAYWALL_IN_USE payload on a 409", () => {
    const err = new ApiError(
      "HTTP_ERROR",
      JSON.stringify({
        code: "PAYWALL_IN_USE",
        message: "Cannot delete paywall p1: referenced by one or more placement rows",
      }),
      409,
    );
    expect(isPaywallInUse(err)).toBe(true);
  });

  it("returns false for a non-409 status", () => {
    const err = new ApiError(
      "HTTP_ERROR",
      JSON.stringify({ code: "PAYWALL_IN_USE", message: "x" }),
      404,
    );
    expect(isPaywallInUse(err)).toBe(false);
  });

  it("returns false when the message isn't JSON", () => {
    const err = new ApiError("HTTP_ERROR", "Conflict", 409);
    expect(isPaywallInUse(err)).toBe(false);
  });

  it("returns false for a different 409 code", () => {
    const err = new ApiError(
      "HTTP_ERROR",
      JSON.stringify({ code: "SOME_OTHER_CONFLICT", message: "x" }),
      409,
    );
    expect(isPaywallInUse(err)).toBe(false);
  });
});
