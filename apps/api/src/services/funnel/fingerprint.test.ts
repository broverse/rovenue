import { describe, expect, it } from "vitest";
import { normalizeFingerprint, fingerprintsMatch, hashIp } from "./fingerprint";

describe("fingerprint", () => {
  it("normalizes locale and timezone to canonical form", () => {
    const f = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "Mozilla/5.0",
      locale: "en_US",
      timezone: "Europe/Istanbul",
      screenDims: "390 x 844",
      deviceModel: " iPhone15,2 ",
    });
    expect(f.locale).toBe("en-US");
    expect(f.timezone).toBe("Europe/Istanbul");
    expect(f.screenDims).toBe("390x844");
    expect(f.deviceModel).toBe("iPhone15,2");
    expect(f.ipHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches identical fingerprints", () => {
    const base = {
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
      deviceModel: "iPhone15,2",
    };
    const a = normalizeFingerprint(base);
    const b = normalizeFingerprint(base);
    expect(fingerprintsMatch(a, b)).toBe(true);
  });

  it("matches when device model is missing on one side", () => {
    const a = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
    });
    const b = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
      deviceModel: "iPhone15,2",
    });
    expect(fingerprintsMatch(a, b)).toBe(true);
  });

  it("does not match when IP hash differs", () => {
    const a = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
    });
    const b = normalizeFingerprint({
      ip: "9.9.9.9",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
    });
    expect(fingerprintsMatch(a, b)).toBe(false);
  });

  it("does not match when timezone differs", () => {
    const a = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
    });
    const b = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "America/Los_Angeles",
      screenDims: "390x844",
    });
    expect(fingerprintsMatch(a, b)).toBe(false);
  });

  it("hashIp is deterministic with the configured salt", () => {
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("9.9.9.9"));
  });

  it("treats screenDims '0x0' as a wildcard during match", () => {
    const stored = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "0x0",
    });
    const sdkSide = normalizeFingerprint({
      ip: "1.2.3.4",
      userAgent: "ua",
      locale: "en-US",
      timezone: "Europe/Istanbul",
      screenDims: "390x844",
    });
    expect(fingerprintsMatch(stored, sdkSide)).toBe(true);
  });
});
