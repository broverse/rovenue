import { describe, it, expect, vi } from "vitest";

// `vi.hoisted` runs BEFORE the imports below. This matters: `lib/env`
// parses process.env at import time, and a plain `beforeAll` would run
// after the module graph is already built — a known footgun in this
// repo, where top-of-file `process.env` assignments are dead code.
// The base deliberately carries BOTH hazards this module has to
// survive: a path prefix (path-style MinIO puts the bucket in the path)
// and a trailing slash. Testing against a bare origin would leave both
// code paths unexercised while looking fully covered.
vi.hoisted(() => {
  process.env.ASSET_PUBLIC_BASE_URL ??= "https://cdn.example.test/rovenue-assets/";
});

import { buildStorageKey, publicUrl, parseAssetUrl } from "../../src/lib/asset-store";

describe("asset URL shape", () => {
  const projectId = "prj_abc123";
  const assetId = "ast_def456";

  it("round-trips a built key through publicUrl and back", () => {
    const key = buildStorageKey(projectId, assetId, "image");
    const parsed = parseAssetUrl(publicUrl(key));
    expect(parsed).toEqual({ projectId, assetId });
  });

  it("round-trips every kind", () => {
    for (const kind of ["image", "video", "lottie"] as const) {
      const key = buildStorageKey(projectId, assetId, kind);
      expect(parseAssetUrl(publicUrl(key))).toEqual({ projectId, assetId });
    }
  });

  it("gives each kind its own extension", () => {
    expect(buildStorageKey(projectId, assetId, "image")).toMatch(/\.webp$/);
    expect(buildStorageKey(projectId, assetId, "video")).toMatch(/\.mp4$/);
    expect(buildStorageKey(projectId, assetId, "lottie")).toMatch(/\.json$/);
  });

  it("does not double the slash when the base URL has a trailing one", () => {
    // The hoisted base above ends in "/", so this exercises the strip
    // for real. Against a slash-less base the test would be
    // self-confirming — deleting the strip from `publicUrl` would leave
    // it green, because there would be nothing to strip.
    const key = buildStorageKey(projectId, assetId, "image");
    expect(publicUrl(key)).toBe(`https://cdn.example.test/rovenue-assets/${key}`);
    expect(publicUrl(key)).not.toContain("//prj_");
  });

  it("rejects a URL under our origin but outside our base path", () => {
    expect(
      parseAssetUrl(`https://cdn.example.test/other-bucket/${projectId}/${assetId}.webp`),
    ).toBeNull();
  });

  it("returns null for a URL that is not ours", () => {
    expect(parseAssetUrl("https://example.com/hero.png")).toBeNull();
    expect(parseAssetUrl("https://cdn.example.test/nope")).toBeNull();
    expect(parseAssetUrl("not a url")).toBeNull();
  });
});
