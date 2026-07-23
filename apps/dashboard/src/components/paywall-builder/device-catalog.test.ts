import { describe, expect, it } from "vitest";
import {
  CANVAS_DEVICES,
  DEFAULT_DEVICE_ID,
  deviceById,
  devicesForPlatform,
} from "./device-catalog";

describe("device-catalog", () => {
  it("catalog carries the four spec devices with accurate frame data", () => {
    const byId = Object.fromEntries(CANVAS_DEVICES.map((d) => [d.id, d]));
    expect(byId.iphone15).toMatchObject({
      platform: "ios",
      w: 393,
      h: 852,
      safeTop: 59,
      safeBottom: 34,
      notch: "dynamic-island",
    });
    expect(byId.iphonese).toMatchObject({ platform: "ios", w: 375, h: 667, safeBottom: 0, notch: "none" });
    expect(byId.pixel8).toMatchObject({ platform: "android", w: 412, h: 915, notch: "punch-hole" });
    expect(byId.galaxya).toMatchObject({ platform: "android", w: 360, h: 800 });
  });

  it("devicesForPlatform filters and preserves catalog order", () => {
    expect(devicesForPlatform("ios").map((d) => d.id)).toEqual(["iphone15", "iphonese"]);
    expect(devicesForPlatform("android").map((d) => d.id)).toEqual(["pixel8", "galaxya"]);
  });

  it("deviceById returns the match", () => {
    expect(deviceById("pixel8").label).toBe("Pixel 8");
  });

  it("deviceById falls back to the default for an unknown id", () => {
    expect(deviceById("nope").id).toBe(DEFAULT_DEVICE_ID);
    expect(deviceById("").id).toBe(DEFAULT_DEVICE_ID);
  });

  it("DEFAULT_DEVICE_ID is a real catalog entry", () => {
    expect(CANVAS_DEVICES.some((d) => d.id === DEFAULT_DEVICE_ID)).toBe(true);
  });
});
