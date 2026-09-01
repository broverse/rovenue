// =============================================================
// readProceeds — estimated proceeds after store commission (Task 5,
// 2026-09-01 analytics-integrity-and-proceeds plan)
// =============================================================
//
// The schema-contract test proves this SQL is valid against the real
// ClickHouse schema (once wired into the REGISTRY invokers). This file
// proves the TypeScript shaping: gross/refunds arrive per store from
// ClickHouse, the configured rate is resolved per store from Postgres
// (mocked the same way proceeds.test.ts mocks `@rovenue/db`), and the
// two are composed WITHOUT blending stores into one figure — a store
// with no configured rate must surface `rate: null` / `proceedsUsd:
// null` on its own row, never a borrowed 0% or a folded-in total.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isClickHouseConfiguredMock = vi.fn();
const queryAnalyticsMock = vi.fn();

vi.mock("../../lib/clickhouse", () => ({
  isClickHouseConfigured: (...args: unknown[]) =>
    isClickHouseConfiguredMock(...args),
  queryAnalytics: (...args: unknown[]) => queryAnalyticsMock(...args),
  ClickHouseUnavailableError: class ClickHouseUnavailableError extends Error {},
}));

// Same technique as proceeds.test.ts: mock the @rovenue/db module
// boundary so resolveCommissionRate's Postgres read is a controlled
// double, not a real database.
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      commissionRateRepo: { getCommissionRate: vi.fn() },
    },
  };
});

import { drizzle } from "@rovenue/db";
import { readProceeds } from "./charts";

const getCommissionRateMock = (
  drizzle as unknown as {
    commissionRateRepo: { getCommissionRate: ReturnType<typeof vi.fn> };
  }
).commissionRateRepo.getCommissionRate;

const FROZEN_NOW = new Date("2026-07-02T12:00:00.000Z");

describe("readProceeds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    queryAnalyticsMock.mockReset();
    getCommissionRateMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("nets refunds from gross before applying each store's OWN configured rate — never blended", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([
      { store: "APP_STORE", gross_usd: "1000", refunds_usd: "200" },
      { store: "PLAY_STORE", gross_usd: "500", refunds_usd: "0" },
    ]);
    // APP_STORE has a configured rate; PLAY_STORE does not.
    getCommissionRateMock.mockImplementation(
      async (_db: unknown, _projectId: string, store: string) =>
        store === "APP_STORE" ? { rate: "0.30" } : null,
    );

    const res = await readProceeds("proj_1", 28);

    expect(res.windowDays).toBe(28);
    expect(res.rows).toHaveLength(2);

    const appStore = res.rows.find((r) => r.store === "APP_STORE");
    expect(appStore?.grossUsd).toBe("1000");
    expect(appStore?.refundsUsd).toBe("200");
    expect(appStore?.netUsd).toBe("800.0000");
    expect(appStore?.rate).toBeCloseTo(0.3, 8);
    // (1000 - 200) * (1 - 0.3) = 560
    expect(appStore?.proceedsUsd).toBe("560.0000");

    const playStore = res.rows.find((r) => r.store === "PLAY_STORE");
    expect(playStore?.rate).toBeNull();
    // A missing rate must not surface as "the store takes nothing" —
    // proceeds must be null, not netUsd or 0.
    expect(playStore?.proceedsUsd).toBeNull();
    expect(playStore?.netUsd).toBe("500.0000");

    expect(getCommissionRateMock).toHaveBeenCalledWith(
      {},
      "proj_1",
      "APP_STORE",
    );
    expect(getCommissionRateMock).toHaveBeenCalledWith(
      {},
      "proj_1",
      "PLAY_STORE",
    );
  });

  it("issues zero queries when no store had any revenue in the window", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([]);

    const res = await readProceeds("proj_1", 28);

    expect(res.rows).toEqual([]);
    expect(getCommissionRateMock).not.toHaveBeenCalled();
  });

  it("SQL nets REFUND and CHARGEBACK out of gross, per store", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([]);
    await readProceeds("proj_1", 28);

    const [, sql] = queryAnalyticsMock.mock.calls[0] as [string, string];
    expect(sql).toContain("raw_revenue_events");
    expect(sql).toContain("REFUND");
    expect(sql).toContain("CHARGEBACK");
    expect(sql).toContain("GROUP BY store");
  });
});
