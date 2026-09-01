import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { ExperimentResultsResponse, ExperimentDecisionGate } from "@rovenue/shared";
import { renderWithRouter } from "../../../tests/render";
import { ExperimentAnalysisCard } from "./experiment-analysis-card";
import type { ExperimentSummary } from "./types";

function makeExperiment(overrides: Partial<ExperimentSummary> = {}): ExperimentSummary {
  return {
    id: "exp_1",
    key: "pricing_test",
    status: "running",
    description: "",
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

/** Same shape as `format.test.ts`'s `makeResults`, with `blockedBy`
 *  driving the decision-state branch each test is actually about. */
function makeResults(
  blockedBy: ExperimentDecisionGate[],
  overrides: Partial<ExperimentResultsResponse> = {},
): ExperimentResultsResponse {
  return {
    experimentId: "exp_1",
    status: "RUNNING",
    primaryMetric: "CONVERSION",
    variants: [],
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
      leadingVariantId: blockedBy.length === 0 ? "variant_a" : null,
      shipRecommended: blockedBy.length === 0,
      blockedBy,
    },
    ...overrides,
  };
}

describe("ExperimentAnalysisCard — decision verdict (Task 5, Step 3 & 4)", () => {
  // TanStack Router's RouterProvider resolves asynchronously even with
  // memory history — settle on the card's own title before asserting.
  async function settle() {
    await screen.findByText("Analysis");
  }

  it("gives 'not enough data' and 'no difference' distinct copy — they must never collide", async () => {
    const { unmount } = renderWithRouter(
      <ExperimentAnalysisCard
        experiment={makeExperiment()}
        results={makeResults(["SAMPLE_SIZE"])}
      />,
    );
    await settle();
    const insufficientText = screen.getByText(/still gathering exposures/i);
    expect(insufficientText).toBeInTheDocument();
    expect(screen.queryByText(/no meaningful difference/i)).not.toBeInTheDocument();
    unmount();

    renderWithRouter(
      <ExperimentAnalysisCard
        experiment={makeExperiment()}
        results={makeResults(["EXPECTED_LOSS"])}
      />,
    );
    await settle();
    expect(screen.getByText(/no meaningful difference/i)).toBeInTheDocument();
    expect(screen.queryByText(/still gathering exposures/i)).not.toBeInTheDocument();
  });

  it("renders every blocked gate, not just the first (blockedBy is ordered, all must show)", async () => {
    renderWithRouter(
      <ExperimentAnalysisCard
        experiment={makeExperiment()}
        results={makeResults(["SRM", "CROSSOVER", "REFUND_GUARDRAIL"])}
      />,
    );
    await settle();

    // Primary reason (blockedBy[0] = SRM) drives the integrity-blocked
    // verdict copy...
    expect(
      screen.getByText(/recommendation withheld — a data-integrity check failed/i),
    ).toBeInTheDocument();
    // ...but every gate in the array gets its own line underneath.
    expect(screen.getByText(/sample ratio mismatch/i)).toBeInTheDocument();
    expect(
      screen.getByText(/exposed to more than one variant/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/refund rate is materially worse/i),
    ).toBeInTheDocument();
  });

  it("shows the ship verdict with no blocked-gate list when every gate passed", async () => {
    renderWithRouter(
      <ExperimentAnalysisCard
        experiment={makeExperiment({ shipRecommended: true, leadingVariant: "variant_a" })}
        results={makeResults([])}
      />,
    );
    await settle();

    expect(screen.getByText(/ready to ship/i)).toBeInTheDocument();
    expect(screen.queryByText(/sample size not yet reached/i)).not.toBeInTheDocument();
  });

  it("surfaces crossCheck.signDisagreement with a visible caution note", async () => {
    renderWithRouter(
      <ExperimentAnalysisCard
        experiment={makeExperiment()}
        results={makeResults(["SAMPLE_SIZE"], {
          crossCheck: {
            posteriorRelativeLift: 0.08,
            welchRelativeLift: -0.03,
            signDisagreement: true,
          },
        })}
      />,
    );
    await settle();

    expect(
      screen.getByText(/disagree on direction — treat the recommendation with extra caution/i),
    ).toBeInTheDocument();
  });

  it("does not render a sign-disagreement note when the cross-check agrees", async () => {
    renderWithRouter(
      <ExperimentAnalysisCard
        experiment={makeExperiment()}
        results={makeResults(["SAMPLE_SIZE"], {
          crossCheck: {
            posteriorRelativeLift: 0.05,
            welchRelativeLift: 0.04,
            signDisagreement: false,
          },
        })}
      />,
    );
    await settle();

    expect(
      screen.queryByText(/treat the recommendation with extra caution/i),
    ).not.toBeInTheDocument();
  });
});
