import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { ChartCatalogEntry } from "@rovenue/shared";
import { renderWithRouter } from "../../../../../tests/render";
import { ChartsPage } from "./charts";

// =============================================================
// Dispatch regression test — commit d03ad156
// =============================================================
//
// Before that commit, `charts.tsx` rendered `<MrrChartPanel>`
// unconditionally, so selecting e.g. "Churn" from the catalog
// showed MRR data under a "Churn" heading. The fix is the one-line
// `chartId === "mrr"` ternary in `ChartsPage` — this test exists so
// reverting that ternary back to "always render MrrChartPanel" reds
// here, even though `series-chart-panel.test.tsx` (which only
// mounts `SeriesChartPanel` in isolation) can't see it.
//
// Both panel components and the catalog hook are module-mocked so
// the test exercises only `ChartsPage`'s own dispatch logic, not a
// full page's worth of network traffic (channels/funnel/heatmap/
// annotations/etc. have no MSW handlers in this suite).

const useChartCatalog = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/hooks/useProjectCharts", () => ({
  useChartCatalog,
  useDeleteCustomChart: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("../../../../components/charts", () => ({
  AnnotationsPanel: () => null,
  ChannelDonut: () => null,
  ChartCatalog: () => null,
  ChartToolbar: () => null,
  FunnelCard: () => null,
  HourDayHeatmap: () => null,
  NewChartDialog: () => null,
  SqlPreviewCard: () => null,
  MrrChartPanel: () => <div data-testid="mock-mrr-chart-panel" />,
  SeriesChartPanel: ({ chartId }: { chartId: string }) => (
    <div data-testid="mock-series-chart-panel">{chartId}</div>
  ),
}));

function entry(overrides: Partial<ChartCatalogEntry>): ChartCatalogEntry {
  return {
    id: "mrr",
    kind: "system",
    category: "revenue",
    name: "MRR",
    chartType: "area",
    range: "12M",
    config: {},
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function arrangeCatalog(entries: ChartCatalogEntry[]) {
  useChartCatalog.mockReturnValue({ data: { entries }, isLoading: false });
  return renderWithRouter(
    <ChartsPage projectId="proj_1" />,
    "/projects/proj_1/charts",
  );
}

describe("ChartsPage panel dispatch", () => {
  it("renders SeriesChartPanel, not MrrChartPanel, for a non-mrr selection", async () => {
    // The default catalog doesn't include "mrr" at all, so the
    // page's own snap-back effect selects "churn" — the panel that
    // ends up on screen comes purely from `ChartsPage`'s dispatch,
    // not from a simulated click.
    arrangeCatalog([entry({ id: "churn", name: "Churn" })]);
    expect(
      await screen.findByTestId("mock-series-chart-panel"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mock-mrr-chart-panel")).toBeNull();
  });

  it("still renders MrrChartPanel when chartId is mrr", async () => {
    arrangeCatalog([entry({ id: "mrr", name: "MRR" })]);
    expect(
      await screen.findByTestId("mock-mrr-chart-panel"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mock-series-chart-panel")).toBeNull();
  });
});
