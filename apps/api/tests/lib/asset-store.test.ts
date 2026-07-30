import { describe, it, expect, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

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
  // Only listAllKeys()'s pagination test below needs these — the URL
  // helpers above never touch S3 — but isStorageConfigured() checks all
  // five together, so a partial set would make that test silently
  // no-op instead of exercising the real code path.
  process.env.ASSET_STORAGE_ENDPOINT ??= "https://s3.example.test";
  process.env.ASSET_STORAGE_REGION ??= "us-east-1";
  process.env.ASSET_STORAGE_BUCKET ??= "rovenue-assets-test";
  process.env.ASSET_STORAGE_ACCESS_KEY_ID ??= "test-key";
  process.env.ASSET_STORAGE_SECRET_ACCESS_KEY ??= "test-secret";
});

import {
  buildStorageKey,
  publicUrl,
  parseAssetUrl,
  listAllKeys,
} from "../../src/lib/asset-store";

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

describe("listAllKeys pagination", () => {
  // The orphan sweeper's entire safety property rests on this: if
  // listAllKeys() silently truncated at the first page, every key past
  // it would look orphaned — including keys with a perfectly live row —
  // and get deleted. A real MinIO bucket with >1000 objects is
  // impractical to spin up for a test, so this pins the continuation
  // behavior against a mocked S3 client instead.
  it("follows the continuation token across pages", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: "prj_a/ast_1.webp" }, { Key: "prj_a/ast_2.webp" }],
        NextContinuationToken: "page-2-token",
      })
      .resolvesOnce({
        Contents: [{ Key: "prj_a/ast_3.webp" }],
      });

    const keys = await listAllKeys();

    // Every key across BOTH pages is present — the case a silent
    // one-page truncation would fail.
    expect(keys).toEqual([
      "prj_a/ast_1.webp",
      "prj_a/ast_2.webp",
      "prj_a/ast_3.webp",
    ]);

    const calls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args[0].input.ContinuationToken).toBeUndefined();
    expect(calls[1]?.args[0].input.ContinuationToken).toBe("page-2-token");
  });
});
