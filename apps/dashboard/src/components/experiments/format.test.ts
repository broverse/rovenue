import { describe, expect, it } from "vitest";
import type {
  ExperimentDecisionGate,
  ExperimentListItem,
  ExperimentRecommendation,
  ExperimentResultsResponse,
  ExperimentResultsVariant,
} from "@rovenue/shared";
import {
  buildFunnelStages,
  decisionState,
  hasLiveResultsData,
  isPaywallExperimentGroup,
  mapApiExperiment,
  mapResultsVariants,
} from "./format";
import type { ExperimentGroup } from "./types";

describe("isPaywallExperimentGroup", () => {
  it("is true only for the paywall group", () => {
    expect(isPaywallExperimentGroup("paywall")).toBe(true);
  });

  it("is false for every other experiment group", () => {
    const others: ExperimentGroup[] = [
      "pricing",
      "trial",
      "onboarding",
      "engagement",
      "monetization",
    ];
    for (const group of others) {
      expect(isPaywallExperimentGroup(group)).toBe(false);
    }
  });
});

/** Fills the fields `mapResultsVariants` / `buildFunnelStages` do not read,
 *  so each test only states the counts it is actually about. */
function variant(
  partial: Pick<
    ExperimentResultsVariant,
    "variantId" | "exposures" | "uniqueUsers" | "attributedConversions"
  >,
): ExperimentResultsVariant {
  return {
    matureUsers: 0,
    converters: 0,
    conversionRate: null,
    revenueUsd: 0,
    refundsUsd: 0,
    refundRate: null,
    excludedImmature: 0,
    excludedCrossover: 0,
    posteriorMean: null,
    credibleIntervalLow: null,
    credibleIntervalHigh: null,
    probabilityBest: null,
    expectedLoss: null,
    sufficientData: false,
    ...partial,
  };
}

function makeResults(
  variants: ExperimentResultsResponse["variants"],
): ExperimentResultsResponse {
  return {
    experimentId: "exp_1",
    status: "RUNNING",
    primaryMetric: "CONVERSION",
    holdout: null,
    variants,
    conversion: null,
    revenue: null,
    crossCheck: {
      posteriorRelativeLift: null,
      welchRelativeLift: null,
      signDisagreement: false,
    },
    integrity: { srm: null, crossoverRate: null },
    sampleSize: null,
    runtimeDays: null,
    recommendation: {
      leadingVariantId: null,
      shipRecommended: false,
      blockedBy: [],
    },
  };
}

describe("mapResultsVariants", () => {
  it("maps exposures/uniqueUsers straight through and cycles colors by index", () => {
    const results = makeResults([
      variant({ variantId: "control", exposures: 100, uniqueUsers: 90, attributedConversions: 12 }),
      variant({ variantId: "variant_a", exposures: 105, uniqueUsers: 95, attributedConversions: 20 }),
      variant({ variantId: "variant_b", exposures: 98, uniqueUsers: 88, attributedConversions: 9 }),
      variant({ variantId: "variant_c", exposures: 50, uniqueUsers: 40, attributedConversions: 3 }),
    ]);

    const rows = mapResultsVariants(results, true);

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      variantId: "control",
      exposures: 100,
      uniqueUsers: 90,
      attributedConversions: 12,
      colorToken: "default",
      isControl: true,
    });
    expect(rows[1]).toMatchObject({ variantId: "variant_a", colorToken: "primary", isControl: false });
    expect(rows[2]).toMatchObject({ variantId: "variant_b", colorToken: "violet" });
    // Cycles back to "default" past the 3-token palette.
    expect(rows[3]).toMatchObject({ variantId: "variant_c", colorToken: "default" });
  });

  it("nulls attributedConversions when the column isn't gated on — never a fabricated 0", () => {
    const results = makeResults([
      variant({ variantId: "control", exposures: 10, uniqueUsers: 9, attributedConversions: 0 }),
    ]);

    const rows = mapResultsVariants(results, false);

    expect(rows[0]!.attributedConversions).toBeNull();
  });

  it("returns an empty array for a null/undefined payload", () => {
    expect(mapResultsVariants(null, true)).toEqual([]);
    expect(mapResultsVariants(undefined, true)).toEqual([]);
  });
});

describe("hasLiveResultsData", () => {
  it("is false for an empty variants array (no exposures yet / ClickHouse unconfigured)", () => {
    expect(hasLiveResultsData(makeResults([]))).toBe(false);
  });

  it("is false for a null/undefined payload", () => {
    expect(hasLiveResultsData(null)).toBe(false);
    expect(hasLiveResultsData(undefined)).toBe(false);
  });

  it("is true once at least one variant row is present, even with 0 exposures on it", () => {
    // A populated row with a real 0 (e.g. a brand-new variant with one
    // exposed user but zero conversions) is legitimate data, not the
    // "no data" case — only an empty array means "nothing yet".
    expect(
      hasLiveResultsData(
        makeResults([
          variant({ variantId: "control", exposures: 1, uniqueUsers: 1, attributedConversions: 0 }),
        ]),
      ),
    ).toBe(true);
  });
});

describe("buildFunnelStages", () => {
  it("always includes exposures + uniqueUsers stages", () => {
    const rows = mapResultsVariants(
      makeResults([
        variant({ variantId: "control", exposures: 100, uniqueUsers: 90, attributedConversions: 10 }),
      ]),
      false,
    );

    const stages = buildFunnelStages(rows, false);

    expect(stages.map((s) => s.key)).toEqual(["exposures", "uniqueUsers"]);
    expect(stages[0]!.values[0]).toMatchObject({ variantId: "control", value: 100 });
    expect(stages[1]!.values[0]).toMatchObject({ variantId: "control", value: 90 });
  });

  it("adds the attributed stage only when showAttributed is true", () => {
    const rows = mapResultsVariants(
      makeResults([
        variant({ variantId: "control", exposures: 100, uniqueUsers: 90, attributedConversions: 10 }),
      ]),
      true,
    );

    const stages = buildFunnelStages(rows, true);

    expect(stages.map((s) => s.key)).toEqual(["exposures", "uniqueUsers", "attributed"]);
    expect(stages[2]!.values[0]).toMatchObject({ variantId: "control", value: 10 });
  });
});

// =============================================================
// Task 5 — mapApiExperiment's decision hydration + decisionState
// =============================================================

function makeListItem(overrides: Partial<ExperimentListItem> = {}): ExperimentListItem {
  return {
    id: "exp_1",
    projectId: "proj_1",
    name: "Pricing test",
    description: null,
    type: "OFFERING",
    key: "pricing_test",
    audienceId: "aud_1",
    status: "RUNNING",
    variants: [
      { id: "control", name: "Control", value: null, weight: 0.5 },
      { id: "variant_a", name: "Variant A", value: null, weight: 0.5 },
    ],
    metrics: ["conversion_rate"],
    mutualExclusionGroup: null,
    primaryMetric: "CONVERSION",
    minimumDetectableEffect: "0.1000",
    startedAt: "2026-08-01T00:00:00Z",
    completedAt: null,
    winnerVariantId: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("mapApiExperiment — decision hydration (Task 5, Step 1)", () => {
  it("never returns a fabricated zero confidence or a guessed leader with no results", () => {
    const summary = mapApiExperiment(makeListItem());

    expect(summary.confidence).toBeNull();
    expect(summary.leadingVariant).toBeNull();
    expect(summary.shipRecommended).toBe(false);
  });

  it("hydrates confidence from the leading variant's probabilityBest, never a bare 0", () => {
    const results = makeResults([
      variant({ variantId: "control", exposures: 100, uniqueUsers: 90, attributedConversions: 10 }),
      variant({
        variantId: "variant_a",
        exposures: 100,
        uniqueUsers: 90,
        attributedConversions: 20,
      }),
    ]);
    results.variants[1]!.probabilityBest = 0.91;
    results.variants[1]!.sufficientData = true;
    results.recommendation = {
      leadingVariantId: "variant_a",
      shipRecommended: true,
      blockedBy: [],
    };

    const summary = mapApiExperiment(makeListItem(), results);

    expect(summary.confidence).toBe(0.91);
    expect(summary.leadingVariant).toBe("variant_a");
    expect(summary.shipRecommended).toBe(true);
  });

  it("hydrates a real signed lift from the leader vs control posterior means", () => {
    const results = makeResults([
      variant({ variantId: "control", exposures: 100, uniqueUsers: 90, attributedConversions: 10 }),
      variant({ variantId: "variant_a", exposures: 100, uniqueUsers: 90, attributedConversions: 20 }),
    ]);
    results.variants[0]!.posteriorMean = 0.1;
    results.variants[1]!.posteriorMean = 0.15;
    results.recommendation = {
      leadingVariantId: "variant_a",
      shipRecommended: true,
      blockedBy: [],
    };

    const summary = mapApiExperiment(makeListItem(), results);

    expect(summary.lift).toBeCloseTo(50, 5); // (0.15 - 0.1) / 0.1 * 100
  });

  it("withholds confidence when the leader is suppressed (SRM/CROSSOVER/REFUND_GUARDRAIL fired)", () => {
    const results = makeResults([
      variant({ variantId: "control", exposures: 100, uniqueUsers: 90, attributedConversions: 10 }),
    ]);
    results.recommendation = {
      leadingVariantId: null,
      shipRecommended: false,
      blockedBy: ["SRM"],
    };

    const summary = mapApiExperiment(makeListItem(), results);

    expect(summary.confidence).toBeNull();
    expect(summary.leadingVariant).toBeNull();
    expect(summary.shipRecommended).toBe(false);
  });
});

describe("decisionState — the four verdict buckets (Task 5, Step 3)", () => {
  function recommendation(
    blockedBy: ExperimentDecisionGate[],
    shipRecommended = false,
  ): ExperimentRecommendation {
    return { leadingVariantId: null, shipRecommended, blockedBy };
  }

  it("is 'ship' whenever shipRecommended is true, regardless of blockedBy", () => {
    expect(decisionState(recommendation([], true))).toBe("ship");
  });

  it.each<ExperimentDecisionGate>(["SAMPLE_SIZE", "RUNTIME", "NO_LEADER"])(
    "is 'insufficientData' when the primary gate is %s",
    (gate) => {
      expect(decisionState(recommendation([gate]))).toBe("insufficientData");
    },
  );

  it.each<ExperimentDecisionGate>([
    "SRM",
    "CROSSOVER",
    "REFUND_GUARDRAIL",
    "PROCEEDS_RATE_UNCONFIGURED",
  ])("is 'integrityBlocked' when the primary gate is %s", (gate) => {
    expect(decisionState(recommendation([gate]))).toBe("integrityBlocked");
  });

  it("is 'noDifference' when the only blocking gate is EXPECTED_LOSS", () => {
    expect(decisionState(recommendation(["EXPECTED_LOSS"]))).toBe("noDifference");
  });

  it("classifies by the PRIMARY (first) gate, not a later one in the array", () => {
    // SAMPLE_SIZE evaluates before EXPECTED_LOSS — still gathering data
    // takes precedence over "not confident enough" when both are present.
    expect(decisionState(recommendation(["SAMPLE_SIZE", "EXPECTED_LOSS"]))).toBe(
      "insufficientData",
    );
  });
});
