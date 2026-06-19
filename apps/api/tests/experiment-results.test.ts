import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// experiment-results service unit test
// =============================================================
//
// Mocks the analytics-router so the service under test exercises
// its aggregation + stats branches without a live ClickHouse.
// Also stubs the experiment repo to return a matching projectId.

const mockRunAnalyticsQuery = vi.hoisted(() =>
  vi.fn(async () => [] as unknown[]),
);

vi.mock("../src/services/analytics-router", () => ({
  runAnalyticsQuery: mockRunAnalyticsQuery,
}));

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {} as unknown,
    experimentRepo: {
      findExperimentById: vi.fn(async (_db: unknown, id: string) => ({
        id,
        projectId: "proj_test",
        status: "RUNNING",
      })),
    },
  },
}));

import { computeExperimentResults } from "../src/services/experiment-results";

describe("computeExperimentResults", () => {
  beforeEach(() => {
    mockRunAnalyticsQuery.mockReset();
  });

  it("throws when experiment is not found or belongs to another project", async () => {
    mockRunAnalyticsQuery.mockResolvedValueOnce([]);
    await expect(
      computeExperimentResults("exp_1", "proj_other"),
    ).rejects.toThrow(/not found/);
  });

  it("returns a zero-variant shell when CH has no rows", async () => {
    mockRunAnalyticsQuery.mockResolvedValueOnce([]);
    const res = await computeExperimentResults("exp_1", "proj_test");
    expect(res.variants).toHaveLength(0);
    expect(res.srm).toBeNull();
    expect(res.conversion).toBeNull();
    expect(res.revenue).toBeNull();
  });

  it("aggregates exposures + conversions and computes SRM over exposed users", async () => {
    // One row per variant (the per-variant query shape), with the exposed-user
    // denominator (unique_users) and the post-exposure conversion count.
    mockRunAnalyticsQuery.mockResolvedValueOnce([
      {
        variant_id: "control",
        exposures: 1000,
        unique_users: 950,
        conversions: 100,
      },
      {
        variant_id: "treatment",
        exposures: 1005,
        unique_users: 960,
        conversions: 150,
      },
    ]);

    const res = await computeExperimentResults("exp_1", "proj_test");
    expect(res.variants).toHaveLength(2);
    expect(res.variants.map((v) => v.variantId).sort()).toEqual([
      "control",
      "treatment",
    ]);
    // SRM is computed over uniqueUsers (exposed users), not raw exposures.
    expect(res.srm).not.toBeNull();
    expect(res.srm!.isMismatch).toBe(false);
    // Conversions are now wired (not hardcoded 0): the analysis reflects the
    // 100/950 vs 150/960 rates over the exposed-user denominator.
    expect(res.conversion).not.toBeNull();
    expect(res.conversion!.controlRate).toBeCloseTo(100 / 950, 5);
    expect(res.conversion!.variantRate).toBeCloseTo(150 / 960, 5);
  });
});
