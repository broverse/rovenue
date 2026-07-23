import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChartSeriesPoint, ChartSeriesResponse } from "@rovenue/shared";
// initialise i18n so useTranslation() returns real strings in jsdom
import "../../i18n/config";
import { SeriesChartPanel } from "./series-chart-panel";

const useChartSeries = vi.hoisted(() => vi.fn());
vi.mock("../../lib/hooks/useChartSeries", () => ({ useChartSeries }));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function response(
  points: ChartSeriesPoint[],
  overrides: Partial<ChartSeriesResponse> = {},
): ChartSeriesResponse {
  return {
    chartId: "churn",
    unit: "percent",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-03T00:00:00.000Z",
    points,
    supported: true,
    ...overrides,
  };
}

function arrange(
  data: ChartSeriesResponse | undefined,
  extra: Record<string, unknown> = {},
) {
  useChartSeries.mockReturnValue({
    data,
    isLoading: false,
    error: null,
    ...extra,
  });
  return wrap(
    <SeriesChartPanel
      projectId="proj_1"
      chartId="churn"
      chartType="line"
      range="3M"
    />,
  );
}

describe("SeriesChartPanel", () => {
  it("renders the empty state when the chart has no reader", async () => {
    arrange(response([], { supported: false }));
    // The whole point of `supported`: an unwired chart must show an
    // honest empty state, never another chart's data.
    expect(await screen.findByText(/no data for this chart yet/i)).toBeTruthy();
  });

  it("renders points when the chart is supported", async () => {
    arrange(
      response([
        { bucket: "2026-01-01T00:00:00.000Z", value: 40, numerator: 4, denominator: 10 },
        { bucket: "2026-01-02T00:00:00.000Z", value: 60, numerator: 6, denominator: 10 },
      ]),
    );
    expect(screen.queryByText(/no data for this chart yet/i)).toBeNull();
    expect(await screen.findByTestId("series-chart-point-0")).toBeInTheDocument();
    expect(screen.getByTestId("series-chart-point-1")).toBeInTheDocument();
  });

  it("renders a gap, not a zero, for a null-valued day", async () => {
    arrange(
      response([
        { bucket: "2026-01-01T00:00:00.000Z", value: 10, numerator: 1, denominator: 10 },
        { bucket: "2026-01-02T00:00:00.000Z", value: null, numerator: 0, denominator: 0 },
        { bucket: "2026-01-03T00:00:00.000Z", value: 20, numerator: 2, denominator: 10 },
      ]),
    );
    // The undefined day must not render a plotted point at all — a
    // day with no traffic (denominator 0) is a gap, never a 0.
    expect(await screen.findByTestId("series-chart-point-0")).toBeInTheDocument();
    expect(screen.queryByTestId("series-chart-point-1")).toBeNull();
    expect(screen.getByTestId("series-chart-point-2")).toBeInTheDocument();
  });

  it("shows a load error instead of spinning forever", async () => {
    arrange(undefined, { error: new Error("boom") });
    expect(await screen.findByTestId("series-chart-error")).toHaveTextContent(
      /couldn't load this chart/i,
    );
  });

  it("does not show the empty state or an error while still loading", async () => {
    useChartSeries.mockReturnValue({ data: undefined, isLoading: true, error: null });
    wrap(
      <SeriesChartPanel projectId="proj_1" chartId="churn" chartType="line" range="3M" />,
    );
    expect(screen.queryByText(/no data for this chart yet/i)).toBeNull();
    expect(screen.queryByTestId("series-chart-error")).toBeNull();
  });
});
