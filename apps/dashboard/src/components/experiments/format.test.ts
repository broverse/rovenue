import { describe, expect, it } from "vitest";
import type {
  ExperimentResultsResponse,
  ExperimentResultsVariant,
} from "@rovenue/shared";
import {
  buildFunnelStages,
  hasLiveResultsData,
  isPaywallExperimentGroup,
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
