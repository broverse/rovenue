import { describe, expect, it } from "vitest";
import { sterilizeToolResult } from "./sterilize";

describe("sterilizeToolResult", () => {
  it("strips known PII keys at the top level", () => {
    const out = sterilizeToolResult({
      id: "sub_abc",
      email: "alice@acme.com",
      name: "Alice",
      plan: "pro",
    });
    expect(out).toEqual({ id: "sub_abc", plan: "pro" });
  });

  it("strips PII keys recursively in nested objects", () => {
    const out = sterilizeToolResult({
      subscriber: {
        id: "sub_abc",
        email: "alice@acme.com",
        billingAddress: { line1: "1 Main St" },
      },
      activeSince: "2025-01-01",
    });
    expect(out).toEqual({
      subscriber: { id: "sub_abc" },
      activeSince: "2025-01-01",
    });
  });

  it("strips PII keys inside arrays", () => {
    const out = sterilizeToolResult([
      { id: "sub_1", email: "a@x.com", plan: "free" },
      { id: "sub_2", email: "b@x.com", plan: "pro" },
    ]);
    expect(out).toEqual([
      { id: "sub_1", plan: "free" },
      { id: "sub_2", plan: "pro" },
    ]);
  });

  it("passes through primitives unchanged", () => {
    expect(sterilizeToolResult(42)).toBe(42);
    expect(sterilizeToolResult("hello")).toBe("hello");
    expect(sterilizeToolResult(null)).toBe(null);
  });
});
