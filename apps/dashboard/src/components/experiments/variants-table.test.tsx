import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../../../tests/render";
import { VariantsTable } from "./variants-table";
import type { ResultVariantRow } from "./types";

function makeRow(overrides: Partial<ResultVariantRow> = {}): ResultVariantRow {
  return {
    variantId: "control",
    exposures: 100,
    uniqueUsers: 90,
    attributedConversions: null,
    matureUsers: 60,
    converters: 6,
    conversionRate: 0.1,
    excludedImmature: 25,
    excludedCrossover: 5,
    colorToken: "default",
    isControl: true,
    sufficientData: true,
    posteriorMean: 0.12,
    credibleIntervalLow: 0.09,
    credibleIntervalHigh: 0.15,
    probabilityBest: 0.5,
    expectedLoss: 0.001,
    ...overrides,
  };
}

describe("VariantsTable — posterior columns (Task 5, Step 2)", () => {
  // TanStack Router's RouterProvider resolves asynchronously even with
  // memory history — settle on the table's own title before asserting.
  async function settle() {
    await screen.findByText("Variants");
  }

  it("renders posterior mean, credible interval, P(best), and expected loss for a fitted variant", async () => {
    renderWithRouter(
      <VariantsTable
        variants={[
          makeRow({
            variantId: "variant_a",
            posteriorMean: 0.18,
            credibleIntervalLow: 0.14,
            credibleIntervalHigh: 0.22,
            probabilityBest: 0.87,
            expectedLoss: 0.0003,
          }),
        ]}
        showAttributed={false}
      />,
    );
    await settle();

    expect(screen.getByText("0.18")).toBeInTheDocument();
    expect(screen.getByText("0.14 – 0.22")).toBeInTheDocument();
    expect(screen.getByText("87.0%")).toBeInTheDocument();
    expect(screen.getByText("0.0003")).toBeInTheDocument();
  });

  it("shows one merged 'not enough data' cell instead of fabricated dashes when sufficientData is false", async () => {
    renderWithRouter(
      <VariantsTable
        variants={[makeRow({ variantId: "variant_b", sufficientData: false, posteriorMean: null, credibleIntervalLow: null, credibleIntervalHigh: null, probabilityBest: null, expectedLoss: null })]}
        showAttributed={false}
      />,
    );
    await settle();

    expect(screen.getByText("Not enough data yet")).toBeInTheDocument();
    // No posterior numbers should have leaked through as fabricated zeros.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders both a sufficient and an insufficient row side by side without cross-contaminating their columns", async () => {
    renderWithRouter(
      <VariantsTable
        variants={[
          makeRow({ variantId: "control", sufficientData: true, posteriorMean: 0.1 }),
          makeRow({
            variantId: "variant_c",
            sufficientData: false,
            posteriorMean: null,
            credibleIntervalLow: null,
            credibleIntervalHigh: null,
            probabilityBest: null,
            expectedLoss: null,
          }),
        ]}
        showAttributed={false}
      />,
    );
    await settle();

    expect(screen.getByText("0.1")).toBeInTheDocument();
    expect(screen.getByText("Not enough data yet")).toBeInTheDocument();
  });
});

describe("VariantsTable — the windowed denominator is visible", () => {
  async function settle() {
    await screen.findByText("Variants");
  }

  it("shows mature users and both exclusion counts beside the exposed count", async () => {
    // Un-windowed 90 exposed vs a posterior fitted on 60 mature
    // subscribers: without the mature column and the two exclusion counts
    // an operator has no way to tell which number the posterior used.
    renderWithRouter(
      <VariantsTable variants={[makeRow()]} showAttributed={false} />,
    );
    await settle();

    expect(screen.getByText("90")).toBeInTheDocument();
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText("25 / 5")).toBeInTheDocument();
    expect(screen.getByText("10.00%")).toBeInTheDocument();
  });

  it("renders a dash, not 0%, when there are no mature users yet", async () => {
    renderWithRouter(
      <VariantsTable
        variants={[makeRow({ matureUsers: 0, converters: 0, conversionRate: null })]}
        showAttributed={false}
      />,
    );
    await settle();

    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
