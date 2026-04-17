import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  assignBucket,
  isInRollout,
  selectVariant,
} from "../src/lib/bucketing";

// =============================================================
// assignBucket — deterministic murmurhash bucketing
// =============================================================

describe("assignBucket", () => {
  test("returns the same bucket for the same (subscriberId, seed)", () => {
    const a = assignBucket("sub_abc", "paywall-summer");
    const b = assignBucket("sub_abc", "paywall-summer");
    expect(a).toBe(b);
  });

  test("returns a bucket in [0, 9999]", () => {
    for (let i = 0; i < 100; i += 1) {
      const bucket = assignBucket(`sub_${i}`, "any-seed");
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(10_000);
    }
  });

  test("different seeds produce different buckets for the same subscriber", () => {
    const a = assignBucket("sub_same", "seed-a");
    const b = assignBucket("sub_same", "seed-b");
    expect(a).not.toBe(b);
  });

  test("100k random ids are uniformly distributed across 10 bins (±5%)", () => {
    const bins = new Array<number>(10).fill(0);
    const N = 100_000;

    for (let i = 0; i < N; i += 1) {
      const bucket = assignBucket(randomUUID(), "uniformity-check");
      bins[Math.floor(bucket / 1000)]! += 1;
    }

    const expected = N / 10;
    for (const count of bins) {
      const drift = Math.abs(count - expected) / expected;
      expect(drift).toBeLessThan(0.05);
    }
  });
});

// =============================================================
// selectVariant — weight-based pick
// =============================================================

describe("selectVariant", () => {
  const variants = [
    { id: "control", weight: 0.5 },
    { id: "variant_a", weight: 0.5 },
  ] as const;

  test("bucket 0 falls in the first variant", () => {
    expect(selectVariant(0, variants).id).toBe("control");
  });

  test("bucket just below the split goes to control", () => {
    expect(selectVariant(4999, variants).id).toBe("control");
  });

  test("bucket at the split goes to variant_a", () => {
    expect(selectVariant(5000, variants).id).toBe("variant_a");
  });

  test("bucket 9999 goes to the final variant", () => {
    expect(selectVariant(9999, variants).id).toBe("variant_a");
  });

  test("three-way split with uneven weights picks proportionally", () => {
    const three = [
      { id: "a", weight: 0.34 },
      { id: "b", weight: 0.33 },
      { id: "c", weight: 0.33 },
    ];

    expect(selectVariant(0, three).id).toBe("a");
    expect(selectVariant(3399, three).id).toBe("a");
    expect(selectVariant(3400, three).id).toBe("b");
    expect(selectVariant(6699, three).id).toBe("b");
    expect(selectVariant(6700, three).id).toBe("c");
    expect(selectVariant(9999, three).id).toBe("c");
  });

  test("N samples land in weight-proportional counts (±2%)", () => {
    const variants3 = [
      { id: "a", weight: 0.7 },
      { id: "b", weight: 0.3 },
    ];
    const counts = { a: 0, b: 0 } as Record<string, number>;
    const N = 100_000;

    for (let i = 0; i < N; i += 1) {
      const bucket = assignBucket(randomUUID(), "variant-drift");
      const picked = selectVariant(bucket, variants3);
      counts[picked.id] = (counts[picked.id] ?? 0) + 1;
    }

    expect(Math.abs(counts.a! / N - 0.7)).toBeLessThan(0.02);
    expect(Math.abs(counts.b! / N - 0.3)).toBeLessThan(0.02);
  });
});

// =============================================================
// isInRollout — percentage gate
// =============================================================

describe("isInRollout", () => {
  test("percentage 0 never passes", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isInRollout(`sub_${i}`, "seed", 0)).toBe(false);
    }
  });

  test("percentage 1 always passes", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isInRollout(`sub_${i}`, "seed", 1)).toBe(true);
    }
  });

  test("10% rollout hits ~10k out of 100k subscribers (±0.5%)", () => {
    let hits = 0;
    const N = 100_000;

    for (let i = 0; i < N; i += 1) {
      if (isInRollout(randomUUID(), "rollout-seed", 0.1)) hits += 1;
    }

    const drift = Math.abs(hits / N - 0.1);
    expect(drift).toBeLessThan(0.005);
  });

  test("deterministic — same subscriber gets the same answer", () => {
    for (let i = 0; i < 50; i += 1) {
      const id = `stable_${i}`;
      expect(isInRollout(id, "seed", 0.1)).toBe(
        isInRollout(id, "seed", 0.1),
      );
    }
  });
});
