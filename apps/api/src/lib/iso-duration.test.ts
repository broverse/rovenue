import { describe, expect, it } from "vitest";
import { isoDurationToDays } from "./iso-duration";

describe("isoDurationToDays", () => {
  it("parses a day duration", () => {
    expect(isoDurationToDays("P3D")).toBe(3);
  });

  it("parses a week duration", () => {
    expect(isoDurationToDays("P1W")).toBe(7);
  });

  it("parses a month duration", () => {
    expect(isoDurationToDays("P1M")).toBe(30);
  });

  it("parses a year duration", () => {
    expect(isoDurationToDays("P1Y")).toBe(365);
  });

  it("returns null for an unparseable duration", () => {
    expect(isoDurationToDays("not-a-duration")).toBeNull();
  });
});
