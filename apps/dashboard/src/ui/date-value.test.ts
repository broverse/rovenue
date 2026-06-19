import { CalendarDate } from "@internationalized/date";
import { describe, expect, it } from "vitest";
import { dateValueToIso, isoToDateValue } from "./date-value";

describe("isoToDateValue", () => {
  it("parses an ISO `YYYY-MM-DD` string into a CalendarDate", () => {
    const v = isoToDateValue("2026-06-19");
    expect(v).not.toBeNull();
    expect(v?.year).toBe(2026);
    expect(v?.month).toBe(6);
    expect(v?.day).toBe(19);
  });

  it("returns null for null / undefined / empty input", () => {
    expect(isoToDateValue(null)).toBeNull();
    expect(isoToDateValue(undefined)).toBeNull();
    expect(isoToDateValue("")).toBeNull();
  });

  it("returns null for malformed input instead of throwing", () => {
    expect(isoToDateValue("not-a-date")).toBeNull();
    expect(isoToDateValue("2026-13-40")).toBeNull();
    expect(isoToDateValue("06/19/2026")).toBeNull();
  });
});

describe("dateValueToIso", () => {
  it("formats a CalendarDate to ISO `YYYY-MM-DD`", () => {
    expect(dateValueToIso(new CalendarDate(2026, 6, 19))).toBe("2026-06-19");
  });

  it("zero-pads single-digit months and days", () => {
    expect(dateValueToIso(new CalendarDate(2026, 1, 5))).toBe("2026-01-05");
  });

  it("returns null for null / undefined", () => {
    expect(dateValueToIso(null)).toBeNull();
    expect(dateValueToIso(undefined)).toBeNull();
  });

  it("round-trips with isoToDateValue", () => {
    expect(dateValueToIso(isoToDateValue("2024-02-29"))).toBe("2024-02-29");
  });
});
