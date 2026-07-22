import { describe, expect, it } from "vitest";
import { isPaywallExperimentGroup } from "./format";
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
