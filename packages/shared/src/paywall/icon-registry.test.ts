import { describe, expect, it } from "vitest";
import { ICON_NAMES, iconRegistry, isKnownIconName } from "./icon-registry";

describe("icon registry", () => {
  it("exposes twelve icons", () => {
    expect(iconRegistry).toHaveLength(12);
    expect(ICON_NAMES).toHaveLength(12);
  });

  it("has no duplicate names", () => {
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  // Every platform column must be populated for every row — a blank cell is
  // how one platform silently renders nothing.
  it("gives every icon all three platform identifiers", () => {
    for (const entry of iconRegistry) {
      expect(entry.web, `web missing for ${entry.name}`).toBeTruthy();
      expect(entry.androidCategory, `androidCategory missing for ${entry.name}`).toBeTruthy();
      expect(entry.androidIcon, `androidIcon missing for ${entry.name}`).toBeTruthy();
      expect(entry.ios, `ios missing for ${entry.name}`).toBeTruthy();
    }
  });

  it("recognises registry names and rejects others", () => {
    expect(isKnownIconName("check")).toBe(true);
    expect(isKnownIconName("not-a-real-icon")).toBe(false);
  });
});
