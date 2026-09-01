import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: resolveCommissionRate/computeProceedsForProject are a thin
// read-through over commissionRateRepo (Postgres), which already has its
// own repository-level coverage. Mocking the @rovenue/db module boundary
// matches this codebase's convention for Postgres-adjacent unit tests
// (see middleware/usage-lock.test.ts mocking drizzle.projectRepo).
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
import {
  COMMISSION_RATE_PRESETS,
  computeNetRevenue,
  computeProceeds,
  computeProceedsFromGrossAndRefunds,
  computeProceedsForProject,
  resolveCommissionRate,
} from "./proceeds";

const getCommissionRateMock = (
  drizzle as unknown as {
    commissionRateRepo: { getCommissionRate: ReturnType<typeof vi.fn> };
  }
).commissionRateRepo.getCommissionRate;

// resetAllMocks (not clearAllMocks) so a leftover mockResolvedValueOnce
// queue from one test can never leak an implementation into the next.
beforeEach(() => vi.resetAllMocks());

describe("computeProceeds", () => {
  it("applies (1 - rate) to already-net revenue", () => {
    expect(computeProceeds(1000, 0.3)).toBeCloseTo(700, 8);
    expect(computeProceeds(1000, 0)).toBeCloseTo(1000, 8);
    expect(computeProceeds(1000, 1)).toBeCloseTo(0, 8);
  });

  it("rejects a rate outside [0, 1] — a config bug, not a revenue fact", () => {
    expect(() => computeProceeds(1000, 1.5)).toThrow();
    expect(() => computeProceeds(1000, -0.1)).toThrow();
  });
});

describe("computeNetRevenue / computeProceedsFromGrossAndRefunds — refund ordering", () => {
  it("nets refunds from gross BEFORE applying the commission rate", () => {
    // The store returns its own commission on a refund, so the correct
    // shape is (gross - refunds) * (1 - rate).
    const gross = 1000;
    const refunds = 200;
    const rate = 0.3;

    expect(computeNetRevenue(gross, refunds)).toBe(800);
    const proceeds = computeProceedsFromGrossAndRefunds(gross, refunds, rate);
    expect(proceeds).toBeCloseTo(560, 8); // (1000 - 200) * 0.7

    // Pin the ordering: applying the rate first and THEN subtracting the
    // refund (gross * (1 - rate) - refunds) is the bug this test exists to
    // catch, and it produces a different, wrong number.
    const wrongOrderResult = gross * (1 - rate) - refunds;
    expect(wrongOrderResult).toBe(500);
    expect(proceeds).not.toBeCloseTo(wrongOrderResult, 8);
  });

  it("matches composing computeNetRevenue then computeProceeds directly", () => {
    const net = computeNetRevenue(5000, 750);
    expect(computeProceedsFromGrossAndRefunds(5000, 750, 0.15)).toBeCloseTo(
      computeProceeds(net, 0.15),
      8,
    );
  });
});

describe("COMMISSION_RATE_PRESETS", () => {
  it("exposes the two Apple tiers and the Google equivalent as named constants", () => {
    expect(COMMISSION_RATE_PRESETS.APPLE_SMALL_BUSINESS).toBe(0.15);
    expect(COMMISSION_RATE_PRESETS.APPLE_STANDARD).toBe(0.3);
    expect(COMMISSION_RATE_PRESETS.GOOGLE_STANDARD).toBe(0.15);
  });
});

describe("resolveCommissionRate / computeProceedsForProject — driven from configuration", () => {
  it("Apple Small Business Program (15%): proceeds come from the CONFIGURED rate, not a hardcoded product", async () => {
    const presetRow = {
      rate: String(COMMISSION_RATE_PRESETS.APPLE_SMALL_BUSINESS),
    };
    getCommissionRateMock.mockResolvedValueOnce(presetRow);

    const rate = await resolveCommissionRate(
      drizzle.db,
      "proj_1",
      "APP_STORE",
    );
    expect(rate).toBeCloseTo(0.15, 8);

    getCommissionRateMock.mockResolvedValueOnce(presetRow);
    const result = await computeProceedsForProject(drizzle.db, {
      projectId: "proj_1",
      store: "APP_STORE",
      gross: 10_000,
      refunds: 0,
    });
    expect(result.rate).toBeCloseTo(0.15, 8);
    expect(result.proceeds).toBeCloseTo(8500, 8);
    expect(getCommissionRateMock).toHaveBeenCalledWith(
      drizzle.db,
      "proj_1",
      "APP_STORE",
    );
  });

  it("Apple standard (30%): proceeds come from the CONFIGURED rate", async () => {
    getCommissionRateMock.mockResolvedValueOnce({
      rate: String(COMMISSION_RATE_PRESETS.APPLE_STANDARD),
    });

    const result = await computeProceedsForProject(drizzle.db, {
      projectId: "proj_1",
      store: "APP_STORE",
      gross: 10_000,
      refunds: 0,
    });
    expect(result.rate).toBeCloseTo(0.3, 8);
    expect(result.proceeds).toBeCloseTo(7000, 8);
  });

  it("a custom rate configured by the customer is honored exactly, not snapped to a preset", async () => {
    getCommissionRateMock.mockResolvedValueOnce({ rate: "0.2250" });

    const result = await computeProceedsForProject(drizzle.db, {
      projectId: "proj_1",
      store: "PLAY_STORE",
      gross: 4000,
      refunds: 400,
    });
    // (4000 - 400) * (1 - 0.225) = 2790
    expect(result.rate).toBeCloseTo(0.225, 8);
    expect(result.proceeds).toBeCloseTo(2790, 8);
  });

  it("a rate change re-computes an EARLIER period from the same underlying revenue — nothing was written into the events", async () => {
    const historicalGross = 20_000;
    const historicalRefunds = 1_000;

    // First read of an already-elapsed period, taken while 30% was configured.
    getCommissionRateMock.mockResolvedValueOnce({ rate: "0.30" });
    const before = await computeProceedsForProject(drizzle.db, {
      projectId: "proj_1",
      store: "APP_STORE",
      gross: historicalGross,
      refunds: historicalRefunds,
    });
    expect(before.proceeds).toBeCloseTo(13_300, 8); // 19000 * 0.7

    // The customer edits their configured rate (e.g. they newly qualified
    // for Apple's Small Business Program). Re-reading the SAME historical
    // gross/refunds — nothing about the underlying revenue changed — must
    // reflect the NEW rate. If a proceeds figure had been persisted at
    // query time #1, this would still show the old number.
    getCommissionRateMock.mockResolvedValueOnce({ rate: "0.15" });
    const after = await computeProceedsForProject(drizzle.db, {
      projectId: "proj_1",
      store: "APP_STORE",
      gross: historicalGross,
      refunds: historicalRefunds,
    });
    expect(after.proceeds).toBeCloseTo(16_150, 8); // 19000 * 0.85

    expect(after.proceeds).not.toBeCloseTo(before.proceeds!, 8);
  });

  it("a project with no configured rate gets NO proceeds figure at all — never a silent 0%", async () => {
    getCommissionRateMock.mockResolvedValueOnce(null);

    const rate = await resolveCommissionRate(
      drizzle.db,
      "proj_unconfigured",
      "STRIPE",
    );
    expect(rate).toBeNull();

    const result = await computeProceedsForProject(drizzle.db, {
      projectId: "proj_unconfigured",
      store: "STRIPE",
      gross: 500,
      refunds: 0,
    });
    expect(result.rate).toBeNull();
    expect(result.proceeds).toBeNull();
  });
});
