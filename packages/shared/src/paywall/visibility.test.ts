import { describe, expect, it } from "vitest";
import { compareVersions, isNodeVisible } from "./visibility";

describe("compareVersions", () => {
  it("compares component-wise, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
  });

  it("treats missing components as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("2", "2.0.0")).toBe(0);
  });

  it("refuses to guess at a non-numeric component", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBeNull();
    expect(compareVersions("2024.spring", "2024.1")).toBeNull();
  });
});

describe("isNodeVisible", () => {
  const ios = { platform: "ios" as const, appVersion: "2.0.0" };

  it("shows a node with no visibility rules at all", () => {
    expect(isNodeVisible(undefined, ios)).toBe(true);
    expect(isNodeVisible({}, ios)).toBe(true);
  });

  it("honours a platform list", () => {
    expect(isNodeVisible({ platform: ["ios"] }, ios)).toBe(true);
    expect(isNodeVisible({ platform: ["android", "web"] }, ios)).toBe(false);
  });

  it("FAILS OPEN on an empty platform list — it means 'no constraint', not 'nowhere'", () => {
    expect(isNodeVisible({ platform: [] }, ios)).toBe(true);
  });

  it("FAILS OPEN when the renderer does not know its platform", () => {
    expect(isNodeVisible({ platform: ["android"] }, { platform: null, appVersion: "2.0.0" })).toBe(true);
  });

  it("honours both version bounds inclusively", () => {
    expect(isNodeVisible({ minAppVersion: "2.0.0" }, ios)).toBe(true);
    expect(isNodeVisible({ minAppVersion: "2.0.1" }, ios)).toBe(false);
    expect(isNodeVisible({ maxAppVersion: "2.0.0" }, ios)).toBe(true);
    expect(isNodeVisible({ maxAppVersion: "1.9.9" }, ios)).toBe(false);
    expect(isNodeVisible({ minAppVersion: "1.0.0", maxAppVersion: "3.0.0" }, ios)).toBe(true);
  });

  it("FAILS OPEN when the app version is unknown", () => {
    const noVersion = { platform: "ios" as const, appVersion: null };
    expect(isNodeVisible({ minAppVersion: "99.0.0" }, noVersion)).toBe(true);
    expect(isNodeVisible({ maxAppVersion: "0.0.1" }, noVersion)).toBe(true);
  });

  it("FAILS OPEN when a version cannot be compared", () => {
    const beta = { platform: "ios" as const, appVersion: "1.0.0-beta" };
    expect(isNodeVisible({ minAppVersion: "99.0.0" }, beta)).toBe(true);
  });

  it("hides only when every rule that CAN be evaluated says hide", () => {
    expect(isNodeVisible({ platform: ["ios"], minAppVersion: "3.0.0" }, ios)).toBe(false);
    expect(isNodeVisible({ platform: ["android"], minAppVersion: "1.0.0" }, ios)).toBe(false);
  });
});
