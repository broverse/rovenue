import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChartProceedsResponse, ChartProceedsRow } from "@rovenue/shared";
// initialise i18n so useTranslation() returns real strings in jsdom
import "../../i18n/config";
import { ProceedsCard } from "./proceeds-card";

const useChartProceeds = vi.hoisted(() => vi.fn());
vi.mock("../../lib/hooks/useProjectCharts", () => ({ useChartProceeds }));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function row(overrides: Partial<ChartProceedsRow> = {}): ChartProceedsRow {
  return {
    store: "APP_STORE",
    grossUsd: "1000.0000",
    refundsUsd: "0.0000",
    netUsd: "1000.0000",
    rate: 0.3,
    proceedsUsd: "700.0000",
    ...overrides,
  };
}

function response(
  rows: ChartProceedsRow[],
  overrides: Partial<ChartProceedsResponse> = {},
): ChartProceedsResponse {
  return { windowDays: 28, rows, ...overrides };
}

function arrange(
  data: ChartProceedsResponse | undefined,
  extra: Record<string, unknown> = {},
) {
  useChartProceeds.mockReturnValue({ data, isLoading: false, ...extra });
  return wrap(<ProceedsCard projectId="proj_1" />);
}

describe("ProceedsCard", () => {
  it("shows the applied rate and the word 'estimated' next to the figure for a configured store", async () => {
    arrange(
      response([row({ store: "APP_STORE", rate: 0.3, proceedsUsd: "700.0000" })]),
    );
    const cell = await screen.findByTestId("proceeds-rate-APP_STORE");
    // Apple's Small Business tier depends on the developer's
    // whole-account prior-year proceeds and both stores apply tax
    // handling we cannot see — this MUST read as an estimate, never
    // as a payout figure on its own.
    expect(cell).toHaveTextContent(/30(\.0)?%/);
    expect(cell).toHaveTextContent(/estimated/i);
    expect(cell).toHaveTextContent(/\$700/);
    // "$700 estimated at 30.0%" reads as "proceeds ARE 30% of revenue",
    // the opposite of what the rate means. The percentage is what the
    // store took, so say so.
    expect(cell).toHaveTextContent(/after 30(\.0)?% commission/i);
  });

  it("renders an unconfigured store's rate as unknown — never 0% and never a blended total", async () => {
    arrange(
      response([row({ store: "PLAY_STORE", rate: null, proceedsUsd: null })]),
    );
    const cell = await screen.findByTestId("proceeds-rate-PLAY_STORE");
    expect(cell).not.toHaveTextContent(/0%/);
    expect(cell).not.toHaveTextContent(/estimated/i);
    expect(cell.textContent?.toLowerCase()).toMatch(/not configured|unknown/);
  });

  it("shows an empty state when there is no revenue in the window", async () => {
    arrange(response([]));
    expect(await screen.findByTestId("proceeds-empty")).toBeInTheDocument();
  });

  it("does not show the empty state once rows arrive", async () => {
    arrange(response([row()]));
    await screen.findByTestId("proceeds-row-APP_STORE");
    expect(screen.queryByTestId("proceeds-empty")).toBeNull();
  });

  it("renders a configured store and an unconfigured store on their own rows, not blended", async () => {
    arrange(
      response([
        row({ store: "APP_STORE", rate: 0.3, proceedsUsd: "700.0000" }),
        row({
          store: "STRIPE",
          grossUsd: "500.0000",
          netUsd: "500.0000",
          rate: null,
          proceedsUsd: null,
        }),
      ]),
    );
    expect(await screen.findByTestId("proceeds-row-APP_STORE")).toBeInTheDocument();
    expect(await screen.findByTestId("proceeds-row-STRIPE")).toBeInTheDocument();
    expect(screen.getByTestId("proceeds-rate-APP_STORE")).toHaveTextContent(
      /estimated/i,
    );
    expect(screen.getByTestId("proceeds-rate-STRIPE")).not.toHaveTextContent(
      /estimated/i,
    );
  });
});
