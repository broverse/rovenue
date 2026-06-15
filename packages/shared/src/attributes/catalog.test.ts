import { describe, expect, it } from "vitest";
import {
  RESERVED_ATTRIBUTES,
  isReservedKey,
  getReservedDef,
  validateReservedValue,
} from "./catalog";

describe("reserved attribute catalog", () => {
  it("recognises catalogued reserved keys", () => {
    expect(isReservedKey("$email")).toBe(true);
    expect(isReservedKey("$campaign")).toBe(true);
    expect(isReservedKey("favoriteTeam")).toBe(false);
  });

  it("treats an unknown $-prefixed key as reserved (so it can be rejected)", () => {
    expect(isReservedKey("$nope")).toBe(true);
    expect(getReservedDef("$nope")).toBeUndefined();
  });

  it("validates $email format", () => {
    expect(validateReservedValue("$email", "a@b.com")).toBeNull();
    expect(validateReservedValue("$email", "not-an-email")).toMatch(/email/i);
  });

  it("validates $attConsentStatus enum", () => {
    expect(validateReservedValue("$attConsentStatus", "authorized")).toBeNull();
    expect(validateReservedValue("$attConsentStatus", "bogus")).toMatch(/one of/i);
  });

  it("rejects over-long reserved values", () => {
    expect(validateReservedValue("$displayName", "x".repeat(501))).toMatch(/500/);
  });

  it("covers all four reserved groups", () => {
    for (const k of [
      "$email", "$displayName", "$phoneNumber",
      "$fcmTokens", "$apnsTokens",
      "$mediaSource", "$campaign", "$adGroup", "$keyword", "$creative", "$ad",
      "$idfa", "$idfv", "$gpsAdId", "$attConsentStatus",
    ]) {
      expect(RESERVED_ATTRIBUTES[k]).toBeDefined();
    }
  });
});
