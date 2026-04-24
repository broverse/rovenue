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

  it("aggregates exposures and computes SRM across two variants", async () => {
    mockRunAnalyticsQuery.mockResolvedValueOnce([
      {
        experiment_id: "exp_1",
        variant_id: "control",
        day: "2026-04-24",
        country: "US",
        platform: "ios",
        exposures: 1000,
        unique_users: 950,
      },
      {
        experiment_id: "exp_1",
        variant_id: "treatment",
        day: "2026-04-24",
        country: "US",
        platform: "ios",
        exposures: 1005,
        unique_users: 960,
      },
    ]);

    const res = await computeExperimentResults("exp_1", "proj_test");
    expect(res.variants).toHaveLength(2);
    expect(res.variants.map((v) => v.variantId).sort()).toEqual([
      "control",
      "treatment",
    ]);
    expect(res.srm).not.toBeNull();
    expect(res.srm!.isMismatch).toBe(false);
  });
});
