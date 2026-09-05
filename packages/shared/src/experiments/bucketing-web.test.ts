import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assignBucket, selectVariant } from "./bucketing";
import { assignBucketWeb } from "./bucketing-web";

// The browser implementation is only useful if it agrees with the others.
// A user who opens the web app must land in the variant their phone already
// put them in, so this checks against the SAME cross-language vectors the
// Node and Rust implementations are checked against — not against the Node
// implementation's output alone, which would let both drift together.

interface BucketingVector {
  subscriberId: string;
  seed: string;
  expectedBucket: number;
  variants: Array<{ id: string; weight: number }>;
  expectedVariantId: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("./bucketing-vectors.json", import.meta.url), "utf8"),
) as { bucketCount: number; cases: BucketingVector[] };

describe("assignBucketWeb", () => {
  it("has vectors to check against", () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  it.each(vectors.cases)(
    "matches the contract vector for $subscriberId/$seed",
    async (vector) => {
      await expect(
        assignBucketWeb(vector.subscriberId, vector.seed),
      ).resolves.toBe(vector.expectedBucket);
    },
  );

  it.each(vectors.cases)(
    "picks the same variant as the contract for $subscriberId/$seed",
    async (vector) => {
      const bucket = await assignBucketWeb(vector.subscriberId, vector.seed);
      expect(selectVariant(bucket, vector.variants).id).toBe(
        vector.expectedVariantId,
      );
    },
  );

  it("agrees with the Node implementation on arbitrary inputs", async () => {
    // The vectors are a fixed set; this widens the check so a divergence in
    // an unvisited corner of the input space is caught too.
    for (let i = 0; i < 200; i++) {
      const id = `sub_${i}_${i * 7919}`;
      const seed = `exp_${i % 13}`;
      expect(await assignBucketWeb(id, seed)).toBe(assignBucket(id, seed));
    }
  });

  it("says so plainly when WebCrypto is missing", async () => {
    const real = globalThis.crypto;
    // http (non-secure) origins have no crypto.subtle. Bucketing everyone to
    // the first variant there would corrupt an experiment silently.
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
    });
    await expect(assignBucketWeb("a", "b")).rejects.toThrow(/secure origins/);
    Object.defineProperty(globalThis, "crypto", {
      value: real,
      configurable: true,
    });
  });
});
