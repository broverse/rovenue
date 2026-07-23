import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChartSeriesPoint, ChartSeriesResponse } from "@rovenue/shared";
// initialise i18n so useTranslation() returns real strings in jsdom
import "../../i18n/config";
import type { RangeOption } from "./types";
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
  range: RangeOption = "3M",
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
      range={range}
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

  // ===========================================================
  // Finding 1 — axis labels must exist and reflect `unit`
  // ===========================================================
  it("renders y-axis labels and formats a percent unit with a % sign", async () => {
    arrange(
      response([
        { bucket: "2026-01-01T00:00:00.000Z", value: 40, numerator: 4, denominator: 10 },
        { bucket: "2026-01-02T00:00:00.000Z", value: 60, numerator: 6, denominator: 10 },
      ]),
    );
    const topLabel = await screen.findByTestId("series-chart-ylabel-0");
    expect(topLabel).toHaveTextContent(/%$/);
  });

  it("formats a count unit's y-axis labels as a plain number, not a percent", async () => {
    arrange(
      response(
        [
          { bucket: "2026-01-01T00:00:00.000Z", value: 400, numerator: 4, denominator: 10 },
          { bucket: "2026-01-02T00:00:00.000Z", value: 600, numerator: 6, denominator: 10 },
        ],
        { unit: "count" },
      ),
    );
    const topLabel = await screen.findByTestId("series-chart-ylabel-0");
    // A count series must render distinctly from a percent series —
    // no "%" and a comma-grouped magnitude, not a near-invisible line
    // that happens to look identical to a 0.4%-vs-92% mixup.
    expect(topLabel).not.toHaveTextContent(/%/);
    expect(topLabel).toHaveTextContent(/^[\d,]+$/);
  });

  it("renders x-axis date labels", async () => {
    arrange(
      response([
        { bucket: "2026-01-01T00:00:00.000Z", value: 40, numerator: 4, denominator: 10 },
        { bucket: "2026-01-02T00:00:00.000Z", value: 60, numerator: 6, denominator: 10 },
      ]),
    );
    expect(await screen.findByTestId("series-chart-xlabel-0")).toBeInTheDocument();
  });

  // ===========================================================
  // Finding 2 — "All" must never silently serve a shorter window
  // ===========================================================
  it("states the actual served window when the selected range exceeds the server's cap", async () => {
    arrange(
      response([
        { bucket: "2026-01-01T00:00:00.000Z", value: 40, numerator: 4, denominator: 10 },
      ]),
      {},
      "All",
    );
    const note = await screen.findByTestId("series-chart-window-note");
    // 24mo (RANGE_MONTHS.All) * 30d would be 720d — the note must
    // reflect the actual 365d cap, not the nominal "All" span.
    expect(note).toHaveTextContent("365");
  });

  it("does not show a window-cap note for a range the server serves in full", async () => {
    arrange(
      response([
        { bucket: "2026-01-01T00:00:00.000Z", value: 40, numerator: 4, denominator: 10 },
      ]),
      {},
      "3M",
    );
    await screen.findByTestId("series-chart-point-0");
    expect(screen.queryByTestId("series-chart-window-note")).toBeNull();
  });

  // ===========================================================
  // Finding 6 — an all-null supported series needs its own affordance
  // ===========================================================
  it("shows a distinct affordance when a supported series has no data in the window", async () => {
    arrange(
      response([
        { bucket: "2026-01-01T00:00:00.000Z", value: null, numerator: 0, denominator: 0 },
        { bucket: "2026-01-02T00:00:00.000Z", value: null, numerator: 0, denominator: 0 },
      ]),
    );
    expect(await screen.findByTestId("series-chart-no-data")).toBeInTheDocument();
    // Must be distinguishable from the `supported: false` empty state —
    // a different affordance for "no reader" vs. "reader has nothing".
    expect(screen.queryByTestId("series-chart-empty")).toBeNull();
  });

  it("does not show the all-null affordance when at least one day has data", async () => {
    arrange(
      response([
        { bucket: "2026-01-01T00:00:00.000Z", value: 10, numerator: 1, denominator: 10 },
        { bucket: "2026-01-02T00:00:00.000Z", value: null, numerator: 0, denominator: 0 },
      ]),
    );
    await screen.findByTestId("series-chart-point-0");
    expect(screen.queryByTestId("series-chart-no-data")).toBeNull();
  });
});
