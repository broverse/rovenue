import { describe, it, expect } from "vitest";
import { ERROR_CODE } from "../index";
import { ERROR_CATALOG } from "../error-catalog";

describe("ERROR_CATALOG", () => {
  it("documents every code exactly once", () => {
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual(Object.keys(ERROR_CODE).sort());
  });

  it("documents each code by its WIRE value, not its key", () => {
    for (const [key, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.code, `${key} documented by key instead of value`).toBe(
        ERROR_CODE[key as keyof typeof ERROR_CODE],
      );
    }
  });

  it("covers the five codes whose key and value diverge", () => {
    const divergent = Object.entries(ERROR_CODE).filter(([k, v]) => k !== v);
    expect(divergent).toHaveLength(5);
    for (const [key, value] of divergent) {
      expect(ERROR_CATALOG[key as keyof typeof ERROR_CODE].code).toBe(value);
    }
  });

  it("has real prose for every entry", () => {
    for (const [key, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.summary.length, `${key} summary too short`).toBeGreaterThan(20);
      expect(entry.resolution.length, `${key} resolution too short`).toBeGreaterThan(20);
      expect(entry.httpStatus).toBeGreaterThanOrEqual(400);
    }
  });
});
