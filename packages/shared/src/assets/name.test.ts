import { describe, it, expect } from "vitest";
import { isValidAssetName, ASSET_NAME_MAX_LENGTH } from "./index";

describe("isValidAssetName", () => {
  it("accepts ordinary names", () => {
    expect(isValidAssetName("hero.png")).toBe(true);
    expect(isValidAssetName("Onboarding hero 2.webp")).toBe(true);
    expect(isValidAssetName("intro-video.mp4")).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(isValidAssetName("")).toBe(false);
  });

  it("rejects a name over the length cap", () => {
    expect(isValidAssetName("a".repeat(ASSET_NAME_MAX_LENGTH + 1))).toBe(false);
  });

  it("rejects a leading period (hidden file)", () => {
    expect(isValidAssetName(".hidden.png")).toBe(false);
  });

  it("rejects sequential periods (directory traversal shape)", () => {
    expect(isValidAssetName("a..b.png")).toBe(false);
    expect(isValidAssetName("../etc/passwd")).toBe(false);
  });

  it("rejects path separators", () => {
    expect(isValidAssetName("dir/hero.png")).toBe(false);
    expect(isValidAssetName("dir\\hero.png")).toBe(false);
  });

  it("rejects characters outside the allowlist", () => {
    expect(isValidAssetName("<script>.png")).toBe(false);
    expect(isValidAssetName("hero\n.png")).toBe(false);
  });
});
