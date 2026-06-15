import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// MRR decomposition mapping
// =============================================================
//
// getMrrDecomposition issues a single aggregate query against the
// ClickHouse raw_revenue_events mirror and maps the row to the
// subscription-MRR decomposition buckets. These tests pin the
// CH -> response mapping (field names + moneyStr formatting) and
// guard the historical bug where RENEWAL revenue landed in NO
// bucket (so the decomposition never reconciled to net MRR) and
// REACTIVATION was mislabelled "expansion".
//
// We mock `queryAnalytics` at the module boundary so no real
// ClickHouse is needed.

const queryAnalyticsMock = vi.fn();
vi.mock("../src/lib/clickhouse", () => ({
  queryAnalytics: (...args: unknown[]) => queryAnalyticsMock(...args),
}));

import { getMrrDecomposition } from "../src/services/metrics/mrr-decomposition";

const INPUT = {
  projectId: "proj_1",
  from: new Date("2026-01-01T00:00:00.000Z"),
  to: new Date("2026-01-31T00:00:00.000Z"),
};

beforeEach(() => {
  queryAnalyticsMock.mockReset();
});

describe("getMrrDecomposition", () => {
  it("maps all four buckets (new, retained, reactivation, churned) with moneyStr formatting", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([
      {
        new_usd: "100",
        retained_usd: "250.5",
        reactivation_usd: "30",
        churned_usd: "12.25",
      },
    ]);

    const d = await getMrrDecomposition(INPUT);

    expect(d).toEqual({
      newUsd: "100.0000",
      retainedUsd: "250.5000",
      reactivationUsd: "30.0000",
      churnedUsd: "12.2500",
    });
  });

  it("does not drop RENEWAL — retained bucket reflects renewal revenue", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([
      {
        new_usd: "0",
        retained_usd: "999",
        reactivation_usd: "0",
        churned_usd: "0",
      },
    ]);

    const d = await getMrrDecomposition(INPUT);

    expect(d.retainedUsd).toBe("999.0000");
    // legacy field must be gone
    expect(d).not.toHaveProperty("expansionUsd");
  });

  it("reactivation is reported in its own field, distinct from new/retained", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([
      {
        new_usd: "0",
        retained_usd: "0",
        reactivation_usd: "42",
        churned_usd: "0",
      },
    ]);

    const d = await getMrrDecomposition(INPUT);

    expect(d.reactivationUsd).toBe("42.0000");
    expect(d.newUsd).toBe("0.0000");
    expect(d.retainedUsd).toBe("0.0000");
  });

  it("falls back to zeroed buckets when CH returns no rows", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([]);

    const d = await getMrrDecomposition(INPUT);

    expect(d).toEqual({
      newUsd: "0.0000",
      retainedUsd: "0.0000",
      reactivationUsd: "0.0000",
      churnedUsd: "0.0000",
    });
  });

  it("buckets reconcile to net: new + retained + reactivation - churned", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([
      {
        new_usd: "100",
        retained_usd: "200",
        reactivation_usd: "50",
        churned_usd: "30",
      },
    ]);

    const d = await getMrrDecomposition(INPUT);
    const net =
      Number(d.newUsd) +
      Number(d.retainedUsd) +
      Number(d.reactivationUsd) -
      Number(d.churnedUsd);

    expect(net).toBeCloseTo(320, 4);
  });

  it("issues the query that buckets RENEWAL into retained and REACTIVATION separately", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([
      {
        new_usd: "0",
        retained_usd: "0",
        reactivation_usd: "0",
        churned_usd: "0",
      },
    ]);

    await getMrrDecomposition(INPUT);

    const sql = String(queryAnalyticsMock.mock.calls[0]![1]);
    expect(sql).toContain("type = 'RENEWAL'");
    expect(sql).toContain("AS retained_usd");
    expect(sql).toContain("type = 'REACTIVATION'");
    expect(sql).toContain("AS reactivation_usd");
    // projectId is passed positionally, from/to as named params
    expect(queryAnalyticsMock.mock.calls[0]![0]).toBe("proj_1");
    expect(queryAnalyticsMock.mock.calls[0]![2]).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });
});
