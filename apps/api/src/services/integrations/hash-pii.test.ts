import { describe, expect, it } from "vitest";
import { hashPii, normalizeEmail, normalizePhone, normalizeExternalId } from "./hash-pii";

describe("hashPii", () => {
  it("lowercases and trims before hashing", () => {
    const a = hashPii("  USER@Example.COM  ");
    const b = hashPii("user@example.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("returns undefined for empty input", () => {
    expect(hashPii("")).toBeUndefined();
    expect(hashPii("   ")).toBeUndefined();
  });
});

describe("normalizers", () => {
  it("normalizeEmail lowercases + trims", () => {
    expect(normalizeEmail("  USER@x.com ")).toBe("user@x.com");
    expect(normalizeEmail("")).toBeUndefined();
  });
  it("normalizePhone strips non-digits", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("15551234567");
    expect(normalizePhone("nope")).toBeUndefined();
  });
  it("normalizeExternalId trims", () => {
    expect(normalizeExternalId(" sub_abc ")).toBe("sub_abc");
    expect(normalizeExternalId("")).toBeUndefined();
  });
});
