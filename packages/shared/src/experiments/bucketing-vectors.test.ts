import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  assignBucket,
  selectVariant,
} from "./bucketing";
import { placementRowsSchema } from "../placements";

// =============================================================
// Bucketing vectors — cross-language contract
// =============================================================

interface BucketingVector {
  subscriberId: string;
  seed: string;
  expectedBucket: number;
  variants: Array<{ id: string; weight: number }>;
  expectedVariantId: string;
}

describe("bucketing-vectors — parity with Rust core", () => {
  const vectors: BucketingVector[] = JSON.parse(
    readFileSync(
      new URL("./bucketing-vectors.json", import.meta.url),
      "utf8",
    ),
  ).cases;

  test("JSON loaded and non-empty", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(12);
  });

  test.each(vectors)(
    "$subscriberId / $seed → bucket $expectedBucket, variant $expectedVariantId",
    ({ subscriberId, seed, expectedBucket, variants, expectedVariantId }) => {
      const bucket = assignBucket(subscriberId, seed);
      expect(bucket).toBe(expectedBucket);

      const variant = selectVariant(bucket, variants);
      expect(variant.id).toBe(expectedVariantId);
    },
  );
});

// =============================================================
// placementRowsSchema — array refinements
// =============================================================

describe("placementRowsSchema refinements", () => {
  test("happy path — single all-users (null) row at the end", () => {
    const rows = [
      { audienceId: "aud_1", target: { type: "paywall" as const, paywallId: "pw_1" } },
      { audienceId: null, target: { type: "none" as const } },
    ];
    const result = placementRowsSchema.safeParse(rows);
    expect(result.success).toBe(true);
  });

  test("happy path — multiple audience rows, no all-users", () => {
    const rows = [
      { audienceId: "aud_1", target: { type: "paywall" as const, paywallId: "pw_1" } },
      { audienceId: "aud_2", target: { type: "experiment" as const, experimentId: "exp_1" } },
    ];
    const result = placementRowsSchema.safeParse(rows);
    expect(result.success).toBe(true);
  });

  test("happy path — audience rows followed by all-users", () => {
    const rows = [
      { audienceId: "aud_1", target: { type: "paywall" as const, paywallId: "pw_1" } },
      { audienceId: "aud_2", target: { type: "experiment" as const, experimentId: "exp_1" } },
      { audienceId: null, target: { type: "none" as const } },
    ];
    const result = placementRowsSchema.safeParse(rows);
    expect(result.success).toBe(true);
  });

  test("rejection — double all-users rows", () => {
    const rows = [
      { audienceId: null, target: { type: "none" as const } },
      { audienceId: null, target: { type: "none" as const } },
    ];
    const result = placementRowsSchema.safeParse(rows);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue =>
        issue.message?.includes("at most one all-users row")
      )).toBe(true);
    }
  });

  test("rejection — all-users row not at the end", () => {
    const rows = [
      { audienceId: null, target: { type: "none" as const } },
      { audienceId: "aud_1", target: { type: "paywall" as const, paywallId: "pw_1" } },
    ];
    const result = placementRowsSchema.safeParse(rows);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue =>
        issue.message?.includes("all-users row must be last")
      )).toBe(true);
    }
  });

  test("rejection — all-users row in the middle", () => {
    const rows = [
      { audienceId: "aud_1", target: { type: "paywall" as const, paywallId: "pw_1" } },
      { audienceId: null, target: { type: "none" as const } },
      { audienceId: "aud_2", target: { type: "experiment" as const, experimentId: "exp_1" } },
    ];
    const result = placementRowsSchema.safeParse(rows);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue =>
        issue.message?.includes("all-users row must be last")
      )).toBe(true);
    }
  });

  test("each target discriminant parses — paywall", () => {
    const row = { audienceId: "aud_1", target: { type: "paywall" as const, paywallId: "pw_1" } };
    const result = placementRowsSchema.safeParse([row]);
    expect(result.success).toBe(true);
  });

  test("each target discriminant parses — experiment", () => {
    const row = { audienceId: "aud_1", target: { type: "experiment" as const, experimentId: "exp_1" } };
    const result = placementRowsSchema.safeParse([row]);
    expect(result.success).toBe(true);
  });

  test("each target discriminant parses — none", () => {
    const row = { audienceId: "aud_1", target: { type: "none" as const } };
    const result = placementRowsSchema.safeParse([row]);
    expect(result.success).toBe(true);
  });
});
