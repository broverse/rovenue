import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CROSSOVER_SUPPRESSION_RATE,
  EXPECTED_LOSS_THRESHOLD,
  HOLDOUT_COHORT_ID,
  MINIMUM_WEEKLY_CYCLES,
  REFUND_GUARDRAIL_MARGIN,
} from "../src/lib/experiment-constants";
import { estimateSampleSize } from "../src/lib/experiment-stats";

// =============================================================
// experiment-results service unit test
// =============================================================
//
// Mocks the analytics-router so the service under test exercises its
// aggregation, posterior and decision branches without a live
// ClickHouse, and stubs the experiment / commission-rate repos.
//
// THE DECISION RULE IS TESTED ONE GATE AT A TIME. Every gate test
// starts from `happyPathRows()` — the fixture in which every clause
// passes — and perturbs exactly ONE input, then asserts that this gate
// alone withholds the recommendation. A single happy-path test plus a
// single everything-wrong test would still pass with three of the four
// clauses unimplemented, which is the failure mode this layout exists
// to prevent.

const DAYS_PER_WEEK = 7;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Comfortably past every runtime gate. */
const LONG_RUNTIME_DAYS = MINIMUM_WEEKLY_CYCLES * DAYS_PER_WEEK + 3;

const mockRunAnalyticsQuery = vi.hoisted(() =>
  vi.fn(async (_q: { kind: string }) => [] as unknown[]),
);
const mockGetCommissionRate = vi.hoisted(() =>
  vi.fn(async (_db: unknown, _projectId: string, _store: string) => ({
    rate: "0.3000",
  }) as { rate: string } | null),
);
const mockExperiment = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("../src/services/analytics-router", () => ({
  runAnalyticsQuery: mockRunAnalyticsQuery,
}));

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {} as unknown,
    experimentRepo: {
      findExperimentById: vi.fn(async (_db: unknown, id: string) => ({
        id,
        ...mockExperiment.current,
      })),
    },
    commissionRateRepo: {
      getCommissionRate: mockGetCommissionRate,
    },
  },
}));

import { computeExperimentResults } from "../src/services/experiment-results";

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

interface RowOverrides {
  variant_id: string;
  [key: string]: unknown;
}

function variantRow(overrides: RowOverrides): Record<string, unknown> {
  return {
    exposures: 21_000,
    unique_users: 20_000,
    conversions: 4_000,
    attributed_conversions: 3_500,
    mature_users: 20_000,
    converters: 2_000,
    sum_log_value: 0,
    sum_log_value_sq: 0,
    revenue_usd: 10_000,
    refunds_usd: 100,
    excluded_immature: 0,
    excluded_crossover: 0,
    ...overrides,
  };
}

/**
 * The fixture in which EVERY clause of the stopping rule passes:
 *   - 20 000 mature users per arm, well past `estimateSampleSize(0.10, 0.10)`
 *   - 10.0% vs 13.0% conversion — a decisive win, so the leader's expected
 *     loss is far below the threshold
 *   - identical exposed-user counts, so SRM does not fire
 *   - zero crossover
 *   - refund rates 1.0% vs 1.1% — inside REFUND_GUARDRAIL_MARGIN
 */
function happyPathRows(): Array<Record<string, unknown>> {
  return [
    variantRow({ variant_id: "control", converters: 2_000, refunds_usd: 100 }),
    variantRow({
      variant_id: "treatment",
      converters: 2_600,
      refunds_usd: 110,
    }),
  ];
}

function setExperiment(overrides: Record<string, unknown> = {}): void {
  mockExperiment.current = {
    key: "exp_1_key",
    projectId: "proj_test",
    status: "RUNNING",
    type: "PAYWALL",
    primaryMetric: "CONVERSION",
    // numeric(5,4) — Drizzle's numeric mode hands this back as a STRING.
    minimumDetectableEffect: "0.1000",
    startedAt: new Date(Date.now() - LONG_RUNTIME_DAYS * MILLISECONDS_PER_DAY),
    variants: [
      { id: "control", name: "Control", value: null, weight: 0.5 },
      { id: "treatment", name: "Treatment", value: null, weight: 0.5 },
    ],
    ...overrides,
  };
}

/** Routes the mocked router by query kind, so a test can supply variant
 *  rows and per-store rows independently. */
function respondWith(
  variantRows: Array<Record<string, unknown>>,
  storeRows: Array<Record<string, unknown>> = [],
): void {
  mockRunAnalyticsQuery.mockImplementation(async (q: { kind: string }) => {
    if (q.kind === "experiment_results") return variantRows;
    if (q.kind === "experiment_revenue_by_store") return storeRows;
    return [];
  });
}

beforeEach(() => {
  mockRunAnalyticsQuery.mockReset();
  mockGetCommissionRate.mockReset();
  mockGetCommissionRate.mockResolvedValue({ rate: "0.3000" });
  setExperiment();
});

// -------------------------------------------------------------
// Plumbing
// -------------------------------------------------------------

describe("computeExperimentResults — plumbing", () => {
  it("throws when experiment is not found or belongs to another project", async () => {
    respondWith([]);
    await expect(
      computeExperimentResults("exp_1", "proj_other"),
    ).rejects.toThrow(/not found/);
  });

  it("returns a zero-variant shell when CH has no rows", async () => {
    respondWith([]);
    const res = await computeExperimentResults("exp_1", "proj_test");
    expect(res.variants).toHaveLength(0);
    expect(res.integrity.srm).toBeNull();
    expect(res.conversion).toBeNull();
    expect(res.recommendation.shipRecommended).toBe(false);
    expect(res.recommendation.leadingVariantId).toBeNull();
  });

  it("passes the experiment's key (not id) as experimentKey to the analytics query", async () => {
    respondWith([]);
    await computeExperimentResults("exp_1", "proj_test");
    expect(mockRunAnalyticsQuery).toHaveBeenCalledWith({
      kind: "experiment_results",
      experimentId: "exp_1",
      experimentKey: "exp_1_key",
      projectId: "proj_test",
    });
  });
});

// -------------------------------------------------------------
// Ruling 6 — the two denominators must not be mixed up
// -------------------------------------------------------------

describe("computeExperimentResults — denominators", () => {
  it("uses mature_users/converters for the metric and unique_users for SRM", async () => {
    // Deliberately divergent: the un-windowed columns say 50/50 on the
    // exposure counts and a 20% conversion rate; the windowed columns say
    // 10% / 13%. A service that read the un-windowed pair would report
    // 0.2 here and silently undo the maturation window.
    respondWith(happyPathRows());
    const res = await computeExperimentResults("exp_1", "proj_test");
    const byId = new Map(res.variants.map((v) => [v.variantId, v]));

    expect(byId.get("control")!.matureUsers).toBe(20_000);
    expect(byId.get("control")!.converters).toBe(2_000);
    expect(byId.get("control")!.conversionRate).toBeCloseTo(0.1, 6);
    expect(byId.get("treatment")!.conversionRate).toBeCloseTo(0.13, 6);
    // The un-windowed columns survive untouched for SRM / back-compat.
    expect(byId.get("control")!.uniqueUsers).toBe(20_000);
    expect(res.conversion!.controlRate).toBeCloseTo(0.1, 6);
    expect(res.conversion!.variantRate).toBeCloseTo(0.13, 6);
  });

  it("reports the exclusion counts and the crossover rate", async () => {
    const rows = happyPathRows();
    rows[0]!.excluded_immature = 500;
    rows[1]!.excluded_crossover = 30;
    respondWith(rows);
    const res = await computeExperimentResults("exp_1", "proj_test");
    const byId = new Map(res.variants.map((v) => [v.variantId, v]));
    expect(byId.get("control")!.excludedImmature).toBe(500);
    expect(byId.get("treatment")!.excludedCrossover).toBe(30);
    // 30 crossover out of (20000 + 500) + (20000 + 30) exposed subscribers.
    expect(res.integrity.crossoverRate).toBeCloseTo(30 / 40_530, 8);
  });
});

// -------------------------------------------------------------
// Ruling 4 — the MDE arrives as a string
// -------------------------------------------------------------

describe("computeExperimentResults — sample size", () => {
  it("converts the numeric-mode MDE string before sizing", async () => {
    respondWith(happyPathRows());
    const res = await computeExperimentResults("exp_1", "proj_test");
    // The control's own windowed rate is the baseline; the MDE is the
    // experiment's own column, converted from "0.1000" to 0.1.
    expect(res.sampleSize).not.toBeNull();
    expect(res.sampleSize!.required).toBe(estimateSampleSize(0.1, 0.1));
    expect(res.sampleSize!.reached).toBe(true);
  });
});

// -------------------------------------------------------------
// The stopping rule — one test per gate
// -------------------------------------------------------------

describe("computeExperimentResults — the stopping rule", () => {
  it("recommends the leader when every gate passes", async () => {
    respondWith(happyPathRows());
    const res = await computeExperimentResults("exp_1", "proj_test");

    expect(res.recommendation.blockedBy).toEqual([]);
    expect(res.recommendation.shipRecommended).toBe(true);
    expect(res.recommendation.leadingVariantId).toBe("treatment");
    expect(res.primaryMetric).toBe("CONVERSION");
    expect(res.runtimeDays).toBe(LONG_RUNTIME_DAYS);

    const treatment = res.variants.find((v) => v.variantId === "treatment")!;
    expect(treatment.probabilityBest).toBeGreaterThan(0.99);
    expect(treatment.posteriorMean).toBeCloseTo(0.13, 3);
    expect(treatment.credibleIntervalLow).not.toBeNull();
    expect(treatment.credibleIntervalHigh).not.toBeNull();
    expect(treatment.credibleIntervalLow!).toBeLessThan(0.13);
    expect(treatment.credibleIntervalHigh!).toBeGreaterThan(0.13);
  });

  it("GATE 1/6 — expected loss alone withholds the recommendation", async () => {
    // 10.00% vs 10.10%: the sample gate, runtime gate and every
    // suppression still pass, but the leader's relative expected loss sits
    // above EXPECTED_LOSS_THRESHOLD.
    const rows = happyPathRows();
    rows[1]!.converters = 2_020;
    respondWith(rows);
    const res = await computeExperimentResults("exp_1", "proj_test");

    expect(res.recommendation.blockedBy).toEqual(["EXPECTED_LOSS"]);
    expect(res.recommendation.shipRecommended).toBe(false);
    // Not a suppression: the leader is still named, it just isn't shippable.
    expect(res.recommendation.leadingVariantId).toBe("treatment");

    const treatment = res.variants.find((v) => v.variantId === "treatment")!;
    const control = res.variants.find((v) => v.variantId === "control")!;
    expect(treatment.expectedLoss! / control.posteriorMean!).toBeGreaterThan(
      EXPECTED_LOSS_THRESHOLD,
    );
  });

  it("GATE 2/6 — the sample-size gate alone withholds the recommendation", async () => {
    // Same 10% / 13% rates, a tenth of the users: the posterior is still
    // decisive (expected loss passes) and the experiment has run long
    // enough, but neither arm has reached the required sample.
    const rows = happyPathRows();
    rows[0]!.mature_users = 2_000;
    rows[0]!.converters = 200;
    rows[1]!.mature_users = 2_000;
    rows[1]!.converters = 260;
    respondWith(rows);
    const res = await computeExperimentResults("exp_1", "proj_test");

    expect(res.recommendation.blockedBy).toEqual(["SAMPLE_SIZE"]);
    expect(res.recommendation.shipRecommended).toBe(false);
    expect(res.recommendation.leadingVariantId).toBe("treatment");
    expect(res.sampleSize!.reached).toBe(false);
  });

  it("GATE 3/6 — the runtime gate alone withholds the recommendation", async () => {
    // Everything else identical to the happy path; the experiment simply
    // has not run a whole weekly cycle yet. A high-traffic app clears the
    // sample gate in a day, which is exactly why this clause is separate.
    setExperiment({
      startedAt: new Date(Date.now() - 2 * MILLISECONDS_PER_DAY),
    });
    respondWith(happyPathRows());
    const res = await computeExperimentResults("exp_1", "proj_test");

    expect(res.recommendation.blockedBy).toEqual(["RUNTIME"]);
    expect(res.recommendation.shipRecommended).toBe(false);
    expect(res.recommendation.leadingVariantId).toBe("treatment");
    expect(res.runtimeDays).toBe(2);
  });

  it("GATE 4/6 — SRM alone suppresses the recommendation and withholds the leader", async () => {
    // Skewed EXPOSED-user counts with the windowed metrics untouched —
    // this also pins Ruling 6 from the other side: SRM must read
    // unique_users, so perturbing only that column has to fire it.
    const rows = happyPathRows();
    rows[1]!.unique_users = 24_000;
    respondWith(rows);
    const res = await computeExperimentResults("exp_1", "proj_test");

    expect(res.recommendation.blockedBy).toEqual(["SRM"]);
    expect(res.recommendation.shipRecommended).toBe(false);
    // Suppression WITHHOLDS the leader — it does not annotate one that
    // still renders.
    expect(res.recommendation.leadingVariantId).toBeNull();
    expect(res.integrity.srm!.isMismatch).toBe(true);
  });

  it("GATE 5/6 — crossover alone suppresses the recommendation and withholds the leader", async () => {
    const rows = happyPathRows();
    // 100 contaminated subscribers out of 40 100 exposed = 0.25%, above
    // CROSSOVER_SUPPRESSION_RATE.
    rows[0]!.excluded_crossover = 50;
    rows[1]!.excluded_crossover = 50;
    respondWith(rows);
    const res = await computeExperimentResults("exp_1", "proj_test");

    expect(res.integrity.crossoverRate!).toBeGreaterThan(
      CROSSOVER_SUPPRESSION_RATE,
    );
    expect(res.recommendation.blockedBy).toEqual(["CROSSOVER"]);
    expect(res.recommendation.shipRecommended).toBe(false);
    expect(res.recommendation.leadingVariantId).toBeNull();
  });

  it("GATE 6/6 — the refund guardrail alone suppresses the recommendation", async () => {
    const rows = happyPathRows();
    // control 1.0% refund rate, leader 2.0% — worse by 100%, well past
    // REFUND_GUARDRAIL_MARGIN.
    rows[1]!.refunds_usd = 200;
    respondWith(rows);
    const res = await computeExperimentResults("exp_1", "proj_test");

    const byId = new Map(res.variants.map((v) => [v.variantId, v]));
    expect(byId.get("control")!.refundRate).toBeCloseTo(0.01, 6);
    expect(byId.get("treatment")!.refundRate).toBeCloseTo(0.02, 6);
    expect(byId.get("treatment")!.refundRate!).toBeGreaterThan(
      byId.get("control")!.refundRate! * (1 + REFUND_GUARDRAIL_MARGIN),
    );

    expect(res.recommendation.blockedBy).toEqual(["REFUND_GUARDRAIL"]);
    expect(res.recommendation.shipRecommended).toBe(false);
    expect(res.recommendation.leadingVariantId).toBeNull();
  });
});

// -------------------------------------------------------------
// Proceeds
// -------------------------------------------------------------

describe("computeExperimentResults — PROCEEDS_PER_USER", () => {
  const storeRows = [
    { variant_id: "control", store: "APP_STORE", revenue_usd: 6_000, refunds_usd: 60 },
    { variant_id: "control", store: "PLAY_STORE", revenue_usd: 4_000, refunds_usd: 40 },
    { variant_id: "treatment", store: "APP_STORE", revenue_usd: 6_000, refunds_usd: 66 },
    { variant_id: "treatment", store: "PLAY_STORE", revenue_usd: 4_000, refunds_usd: 44 },
  ];

  /** Log-value sufficient statistics over the converters: mean log-value 3
   *  with a sample variance of ~0.25, i.e. a real spread of price points. */
  function valueRows(): Array<Record<string, unknown>> {
    const rows = happyPathRows();
    for (const r of rows) {
      const n = r.converters as number;
      r.sum_log_value = 3 * n;
      r.sum_log_value_sq = (9 + 0.25) * n;
    }
    return rows;
  }

  it("reports the metric as unknown when any store has no configured rate", async () => {
    setExperiment({ primaryMetric: "PROCEEDS_PER_USER" });
    respondWith(valueRows(), storeRows);
    mockGetCommissionRate.mockImplementation(
      async (_db: unknown, _projectId: string, store: string) =>
        store === "APP_STORE" ? { rate: "0.3000" } : null,
    );

    const res = await computeExperimentResults("exp_1", "proj_test");
    expect(res.recommendation.blockedBy).toEqual([
      "PROCEEDS_RATE_UNCONFIGURED",
    ]);
    expect(res.recommendation.shipRecommended).toBe(false);
    expect(res.recommendation.leadingVariantId).toBeNull();
    for (const v of res.variants) {
      expect(v.sufficientData).toBe(false);
      expect(v.posteriorMean).toBeNull();
      expect(v.probabilityBest).toBeNull();
    }
  });

  it("computes a posterior when every store has a rate", async () => {
    setExperiment({ primaryMetric: "PROCEEDS_PER_USER" });
    respondWith(valueRows(), storeRows);

    const res = await computeExperimentResults("exp_1", "proj_test");
    expect(res.primaryMetric).toBe("PROCEEDS_PER_USER");
    expect(
      res.recommendation.blockedBy.includes("PROCEEDS_RATE_UNCONFIGURED"),
    ).toBe(false);
    for (const v of res.variants) {
      expect(v.sufficientData).toBe(true);
      expect(v.posteriorMean).not.toBeNull();
      // conversion rate x per-converter proceeds; the 30% commission has
      // to be visible in the level of the number.
      expect(v.posteriorMean!).toBeGreaterThan(0);
    }
  });

  it("reports a real posterior for a single-price paywall, never NaN", async () => {
    // Every converter netted exactly the same amount — one product at one
    // price inside the 7-day window, i.e. the modal configuration. The
    // log-value variance is exactly zero, which the sufficient-statistic
    // form computes as a tiny NEGATIVE number.
    //
    // Two ways to get this wrong, both regressions this pins: letting the
    // negative through produces NaN posteriors with `sufficientData: true`
    // (and a NaN expected loss compares `false` against the threshold, so
    // the stopping rule would recommend shipping an unfitted posterior),
    // while rejecting it outright reports "not enough data" for a paywall
    // with 2 000 converters per arm. Neither is right: the value is known
    // exactly, so the posterior is real and the uncertainty lives in the
    // conversion factor.
    setExperiment({ primaryMetric: "ARPU" });
    const price = 19.99;
    const logPrice = Math.log(price);
    const rows = happyPathRows();
    for (const r of rows) {
      const n = r.converters as number;
      r.sum_log_value = n * logPrice;
      r.sum_log_value_sq = n * logPrice ** 2;
    }
    respondWith(rows);

    const res = await computeExperimentResults("exp_1", "proj_test");
    const byId = new Map(res.variants.map((v) => [v.variantId, v]));

    for (const v of res.variants) {
      expect(v.sufficientData).toBe(true);
      expect(Number.isFinite(v.posteriorMean!)).toBe(true);
      expect(Number.isFinite(v.expectedLoss!)).toBe(true);
      expect(Number.isFinite(v.probabilityBest!)).toBe(true);
    }
    // Beta(1 + converters, 1 + non-converters) mean times the exact price.
    expect(byId.get("control")!.posteriorMean!).toBeCloseTo(
      ((1 + 2_000) / (2 + 20_000)) * price,
      2,
    );
    expect(byId.get("treatment")!.posteriorMean!).toBeCloseTo(
      ((1 + 2_600) / (2 + 20_000)) * price,
      2,
    );
    expect(res.recommendation.blockedBy).toEqual([]);
    expect(res.recommendation.leadingVariantId).toBe("treatment");
  });
});

// -------------------------------------------------------------
// The assumption-free cross-check (spec 4.1)
// -------------------------------------------------------------

describe("computeExperimentResults — Welch cross-check", () => {
  /** Builds one variant row whose raw per-subscriber sufficient statistics
   *  and log-value sufficient statistics are both stated explicitly, so a
   *  test can make the two models genuinely disagree. */
  function arm(overrides: {
    variant_id: string;
    converters: number;
    /** [count, value] pairs over converters; non-converters contribute 0. */
    values: Array<[number, number]>;
    varLog: number;
  }): Record<string, unknown> {
    const { variant_id, converters, values, varLog } = overrides;
    const netSum = values.reduce((acc, [c, v]) => acc + c * v, 0);
    const netSumSq = values.reduce((acc, [c, v]) => acc + c * v * v, 0);
    const sumLog = values.reduce((acc, [c, v]) => acc + c * Math.log(v), 0);
    const meanLog = sumLog / converters;
    return variantRow({
      variant_id,
      converters,
      net_revenue_usd: netSum,
      net_revenue_sq: netSumSq,
      sum_log_value: sumLog,
      // Reconstructed from the stated mean and the requested variance, so
      // the log model's spread is a property of the fixture rather than an
      // accident of the value list.
      sum_log_value_sq:
        converters * meanLog * meanLog + (converters - 1) * varLog,
      revenue_usd: netSum,
      refunds_usd: 0,
    });
  }

  it("agrees with the posterior when the revenue distribution is well behaved", async () => {
    setExperiment({ primaryMetric: "ARPU" });
    respondWith([
      arm({
        variant_id: "control",
        converters: 2_000,
        values: [[2_000, 20]],
        varLog: 0.2,
      }),
      arm({
        variant_id: "treatment",
        converters: 2_600,
        values: [[2_600, 20]],
        varLog: 0.2,
      }),
    ]);

    const res = await computeExperimentResults("exp_1", "proj_test");

    expect(res.revenue).not.toBeNull();
    // Welch runs over MATURE SUBSCRIBERS, not converters: revenue per USER.
    expect(res.revenue!.controlMean).toBeCloseTo((2_000 * 20) / 20_000, 6);
    expect(res.revenue!.variantMean).toBeCloseTo((2_600 * 20) / 20_000, 6);

    expect(res.crossCheck.welchRelativeLift!).toBeGreaterThan(0);
    expect(res.crossCheck.posteriorRelativeLift!).toBeGreaterThan(0);
    expect(res.crossCheck.signDisagreement).toBe(false);
  });

  it("flags the disagreement when a heavy tail carries control's revenue", async () => {
    // Control's raw revenue is carried by 10 whales at $2 000 among 1 990
    // converters at $20. The log-normal fit shrinks those toward the
    // median, so the MODEL prefers treatment while the RAW sample means
    // prefer control. That is exactly the disagreement the spec wants
    // surfaced rather than silently resolved.
    setExperiment({ primaryMetric: "ARPU" });
    respondWith([
      arm({
        variant_id: "control",
        converters: 2_000,
        values: [
          [1_990, 20],
          [10, 2_000],
        ],
        varLog: 0.1055,
      }),
      arm({
        variant_id: "treatment",
        converters: 2_200,
        values: [[2_200, 22]],
        varLog: 0.05,
      }),
    ]);

    const res = await computeExperimentResults("exp_1", "proj_test");

    // Raw data: control ahead on revenue per user.
    expect(res.revenue!.controlMean).toBeGreaterThan(res.revenue!.variantMean);
    expect(res.crossCheck.welchRelativeLift!).toBeLessThan(0);
    // Model: treatment ahead.
    expect(res.crossCheck.posteriorRelativeLift!).toBeGreaterThan(0);

    expect(res.crossCheck.signDisagreement).toBe(true);
    // Shown, not resolved: the flag changes no gate and suppresses nothing.
    expect(res.recommendation.blockedBy).not.toContain("REFUND_GUARDRAIL");
    expect(res.recommendation.leadingVariantId).toBe("treatment");
  });

  it("makes no sign comparison for a CONVERSION experiment", async () => {
    // The posterior estimates a rate and Welch estimates revenue per user
    // — different quantities. Welch is still reported on its own.
    setExperiment({ primaryMetric: "CONVERSION" });
    respondWith(happyPathRows());

    const res = await computeExperimentResults("exp_1", "proj_test");
    expect(res.revenue).not.toBeNull();
    expect(res.crossCheck.welchRelativeLift).not.toBeNull();
    expect(res.crossCheck.posteriorRelativeLift).toBeNull();
    expect(res.crossCheck.signDisagreement).toBe(false);
  });
});

// -------------------------------------------------------------
// The holdout cohort is not an arm
// -------------------------------------------------------------

describe("computeExperimentResults — project holdout cohort", () => {
  /** A 10% holdout beside two 20 000-user arms, exposed under the reserved
   *  cohort id exactly as `publishHoldoutExposure` writes it. */
  function holdoutRow(): Record<string, unknown> {
    return variantRow({
      variant_id: HOLDOUT_COHORT_ID,
      exposures: 2_300,
      unique_users: 2_200,
      mature_users: 2_200,
      converters: 180,
      revenue_usd: 900,
      refunds_usd: 9,
    });
  }

  it("produces the identical verdict with a live holdout and with none", async () => {
    respondWith(happyPathRows());
    const withoutHoldout = await computeExperimentResults(
      "exp_1",
      "proj_test",
    );

    respondWith([...happyPathRows(), holdoutRow()]);
    const withHoldout = await computeExperimentResults("exp_1", "proj_test");

    expect(withHoldout.recommendation).toEqual(withoutHoldout.recommendation);
    expect(withHoldout.integrity.srm).toEqual(withoutHoldout.integrity.srm);
    expect(withHoldout.variants).toEqual(withoutHoldout.variants);
    // The happy path must genuinely be a happy path, or this asserts
    // nothing more than "both are equally broken".
    expect(withHoldout.recommendation.shipRecommended).toBe(true);
    expect(withHoldout.recommendation.blockedBy).toEqual([]);
    expect(withHoldout.integrity.srm!.isMismatch).toBe(false);
  });

  it("keeps the cohort out of the variant list and the cross-checks", async () => {
    respondWith([...happyPathRows(), holdoutRow()]);
    const res = await computeExperimentResults("exp_1", "proj_test");

    expect(res.variants.map((v) => v.variantId)).toEqual([
      "control",
      "treatment",
    ]);
    expect(res.recommendation.leadingVariantId).toBe("treatment");
    // Two-arm cross-checks survive: a third row would have nulled both.
    expect(res.conversion).not.toBeNull();
    expect(res.revenue).not.toBeNull();
  });

  it("reports the cohort's own figures beside the variants", async () => {
    respondWith([...happyPathRows(), holdoutRow()]);
    const res = await computeExperimentResults("exp_1", "proj_test");

    expect(res.holdout).not.toBeNull();
    expect(res.holdout!.cohortId).toBe(HOLDOUT_COHORT_ID);
    expect(res.holdout!.uniqueUsers).toBe(2_200);
    expect(res.holdout!.matureUsers).toBe(2_200);
    expect(res.holdout!.converters).toBe(180);
    expect(res.holdout!.conversionRate).toBeCloseTo(180 / 2_200, 10);
    expect(res.holdout!.revenueUsd).toBe(900);
  });

  it("reports holdout as null when no holdout row exists", async () => {
    respondWith(happyPathRows());
    const res = await computeExperimentResults("exp_1", "proj_test");
    expect(res.holdout).toBeNull();
  });

  it("ignores the cohort's stores when resolving proceeds factors", async () => {
    // The cohort bought through a store with no configured commission
    // rate. That must not make PROCEEDS_PER_USER unknown for the arms.
    setExperiment({ primaryMetric: "PROCEEDS_PER_USER" });
    mockGetCommissionRate.mockImplementation(
      async (_db: unknown, _projectId: string, store: string) =>
        store === "APP_STORE" ? { rate: "0.3000" } : null,
    );
    respondWith(
      [
        variantRow({
          variant_id: "control",
          converters: 2_000,
          sum_log_value: 2_000 * Math.log(10),
          sum_log_value_sq: 2_000 * Math.log(10) ** 2 + 20,
        }),
        variantRow({
          variant_id: "treatment",
          converters: 2_600,
          sum_log_value: 2_600 * Math.log(12),
          sum_log_value_sq: 2_600 * Math.log(12) ** 2 + 26,
        }),
      ],
      [
        { variant_id: "control", store: "APP_STORE", revenue_usd: 10_000, refunds_usd: 100 },
        { variant_id: "treatment", store: "APP_STORE", revenue_usd: 13_000, refunds_usd: 110 },
        { variant_id: HOLDOUT_COHORT_ID, store: "STRIPE", revenue_usd: 900, refunds_usd: 9 },
      ],
    );

    const res = await computeExperimentResults("exp_1", "proj_test");
    expect(res.recommendation.blockedBy).not.toContain(
      "PROCEEDS_RATE_UNCONFIGURED",
    );
  });
});

// -------------------------------------------------------------
// An arm with no mature users is not a leader
// -------------------------------------------------------------

describe("computeExperimentResults — zero-mature-user arm", () => {
  it("is neither the leader nor reported confident", async () => {
    // Reachable in ordinary operation: with a maturation window, any arm
    // whose traffic all arrived inside the window has zero MATURE users
    // while its sibling has thousands. Before the guard this arm came back
    // mean 0.4985 / probabilityBest 98.98% — "Confidence 99%" in the hero,
    // with the manual Ship-winner button enabled.
    respondWith([
      variantRow({ variant_id: "control", converters: 2_000 }),
      variantRow({
        variant_id: "treatment",
        unique_users: 20_000,
        mature_users: 0,
        converters: 0,
        revenue_usd: 0,
        refunds_usd: 0,
        excluded_immature: 20_000,
      }),
    ]);

    const res = await computeExperimentResults("exp_1", "proj_test");
    const treatment = res.variants.find((v) => v.variantId === "treatment")!;

    expect(treatment.matureUsers).toBe(0);
    expect(treatment.sufficientData).toBe(false);
    expect(treatment.posteriorMean).toBeNull();
    expect(treatment.probabilityBest).toBeNull();

    // `pickLeader` needs at least two arms with a fitted posterior, so
    // with one excluded there is no leader to ship or to render a
    // confidence for.
    expect(res.recommendation.leadingVariantId).toBeNull();
    expect(res.recommendation.shipRecommended).toBe(false);
    expect(res.recommendation.blockedBy).toContain("NO_LEADER");
  });
});
