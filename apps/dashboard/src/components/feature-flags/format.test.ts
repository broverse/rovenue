import { describe, it, expect } from "vitest";
import { deriveKeyStatus, FLAG_KEY_PATTERN } from "./format";

describe("deriveKeyStatus", () => {
  const existing = ["new_onboarding_flow", "paywall_v2"];

  it("returns empty for blank or whitespace-only input", () => {
    expect(deriveKeyStatus("", existing)).toBe("empty");
    expect(deriveKeyStatus("   ", existing)).toBe("empty");
  });

  it("returns invalid for keys with disallowed characters", () => {
    expect(deriveKeyStatus("has spaces", existing)).toBe("invalid");
    expect(deriveKeyStatus("nope!", existing)).toBe("invalid");
  });

  it("returns taken for an exact match in the current env list", () => {
    expect(deriveKeyStatus("paywall_v2", existing)).toBe("taken");
    expect(deriveKeyStatus("  paywall_v2  ", existing)).toBe("taken");
  });

  it("is case-sensitive — a case variant is available, not taken", () => {
    expect(deriveKeyStatus("Paywall_V2", existing)).toBe("available");
  });

  it("returns available for a valid, unused key", () => {
    expect(deriveKeyStatus("checkout_redesign", existing)).toBe("available");
  });

  it("treats a key free in this env (empty list) as available", () => {
    // env-switch behavior: same key, different env's list
    expect(deriveKeyStatus("paywall_v2", [])).toBe("available");
  });

  it("exposes the shared key pattern", () => {
    expect(FLAG_KEY_PATTERN.test("good-key_1")).toBe(true);
    expect(FLAG_KEY_PATTERN.test("bad key")).toBe(false);
  });
});
