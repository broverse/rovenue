import { describe, expect, it } from "vitest";
import { ApiError } from "../../../lib/api";
import { extractPlacementApiErrorMessage } from "../placement-errors";

describe("extractPlacementApiErrorMessage", () => {
  it("unwraps the INVALID_ROW_REF JSON payload", () => {
    const err = new ApiError(
      "HTTP_ERROR",
      JSON.stringify({ code: "INVALID_ROW_REF", message: "Unknown audienceId(s): a1" }),
      400,
    );
    expect(extractPlacementApiErrorMessage(err)).toBe("Unknown audienceId(s): a1");
  });

  it("falls back to the raw message when it isn't JSON", () => {
    const err = new ApiError("HTTP_ERROR", "identifier is immutable once set", 400);
    expect(extractPlacementApiErrorMessage(err)).toBe("identifier is immutable once set");
  });

  it("falls back to the raw message when JSON parses but has no message field", () => {
    const err = new ApiError("HTTP_ERROR", JSON.stringify({ code: "X" }), 400);
    expect(extractPlacementApiErrorMessage(err)).toBe(JSON.stringify({ code: "X" }));
  });
});
