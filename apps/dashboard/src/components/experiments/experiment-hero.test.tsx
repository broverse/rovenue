import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../../../tests/render";
import { ExperimentHero } from "./experiment-hero";
import type { ExperimentSummary } from "./types";

/** Fills every field the "ship winner" banner doesn't read, so each test
 *  only states what it's actually about — same convention as
 *  `format.test.ts`'s `variant()` / `makeResults()` helpers. */
function makeExperiment(overrides: Partial<ExperimentSummary> = {}): ExperimentSummary {
  return {
    id: "exp_1",
    key: "pricing_test",
    status: "running",
    description: "Higher entry price on the onboarding paywall.",
    metric: "trial_start_rate",
    started: "2026-08-01T00:00:00Z",
    days: 14,
    ageLabelKey: "experiments.list.age.runningDays",
    ageLabelValues: { days: 14 },
    variantCount: 2,
    assigned: 1200,
    confidence: null,
    outcome: "",
    group: "pricing",
    lift: 0,
    winner: null,
    leadingVariant: null,
    shipRecommended: false,
    ...overrides,
  };
}

describe("ExperimentHero — ship winner banner (Task 5, Step 5)", () => {
  // TanStack Router's RouterProvider resolves the route asynchronously
  // even with memory history, so the body is briefly empty right after
  // `render` — settle on the always-present title before asserting.
  async function settle(key: string) {
    await screen.findByText(key);
  }

  // This is the test that matters: the banner's whole history is being
  // hardcoded to never render (format.ts always shipped `leadingVariant:
  // null`). A leader existing is NOT enough — a blocked gate (sample
  // size, SRM, refund guardrail, expected loss, ...) must keep the
  // banner hidden even though there's a named leading variant.
  it("does NOT render when a decision gate is blocked, even with a named leader", async () => {
    const experiment = makeExperiment({
      leadingVariant: "variant_a",
      shipRecommended: false,
      confidence: 0.92, // a high bare confidence number must not leak through
    });

    renderWithRouter(<ExperimentHero experiment={experiment} projectId="proj_1" />);
    await settle(experiment.key);

    expect(
      screen.queryByRole("button", { name: "Ship variant_a" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/is the leader at/i)).not.toBeInTheDocument();
  });

  it("does NOT render on a low, non-recommended confidence either", async () => {
    const experiment = makeExperiment({
      leadingVariant: "variant_a",
      shipRecommended: false,
      confidence: 0.3,
    });

    renderWithRouter(<ExperimentHero experiment={experiment} projectId="proj_1" />);
    await settle(experiment.key);

    expect(
      screen.queryByRole("button", { name: "Ship variant_a" }),
    ).not.toBeInTheDocument();
  });

  it("renders once every gate has passed (shipRecommended)", async () => {
    const experiment = makeExperiment({
      leadingVariant: "variant_a",
      shipRecommended: true,
      confidence: 0.97,
      lift: 12.4,
    });

    renderWithRouter(<ExperimentHero experiment={experiment} projectId="proj_1" />);
    await settle(experiment.key);

    expect(
      screen.getByRole("button", { name: "Ship variant_a" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/is the leader at/i)).toBeInTheDocument();
  });

  it("stays hidden once a winner has already been shipped, even if shipRecommended is still true", async () => {
    const experiment = makeExperiment({
      leadingVariant: "variant_a",
      shipRecommended: true,
      winner: "variant_a",
    });

    renderWithRouter(<ExperimentHero experiment={experiment} projectId="proj_1" />);
    await settle(experiment.key);

    expect(
      screen.queryByRole("button", { name: "Ship variant_a" }),
    ).not.toBeInTheDocument();
  });

  it("shows an em dash rather than a fabricated 0% when confidence hasn't hydrated", async () => {
    const experiment = makeExperiment({ confidence: null });

    renderWithRouter(<ExperimentHero experiment={experiment} projectId="proj_1" />);
    await settle(experiment.key);

    // The KPI tile's confidence value falls back to the unavailable copy —
    // the only literal instance of "—" among the hero's KPI values.
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });
});
