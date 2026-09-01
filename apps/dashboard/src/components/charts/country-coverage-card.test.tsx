import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChartFilterOptionsResponse } from "@rovenue/shared";
// initialise i18n so useTranslation() returns real strings in jsdom
import "../../i18n/config";
import { CountryCoverageCard } from "./country-coverage-card";

const useChartFilterOptions = vi.hoisted(() => vi.fn());
vi.mock("../../lib/hooks/useProjectCharts", () => ({ useChartFilterOptions }));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function response(
  overrides: Partial<ChartFilterOptionsResponse> = {},
): ChartFilterOptionsResponse {
  return {
    windowDays: 28,
    platform: [],
    country: [],
    countryCoverage: { eventsWithCountry: 0, totalEvents: 0 },
    ...overrides,
  };
}

/** Distinct-country rows, more than the dropdown's 50-row server cap. */
function manyCountries(n: number, perCountry: number) {
  return Array.from({ length: n }, (_, i) => ({
    value: `C${i}`,
    label: `C${i}`,
    count: perCountry,
  }));
}

function arrange(
  data: ChartFilterOptionsResponse | undefined,
  extra: Record<string, unknown> = {},
) {
  useChartFilterOptions.mockReturnValue({ data, isLoading: false, ...extra });
  return wrap(<CountryCoverageCard projectId="proj_1" />);
}

describe("CountryCoverageCard", () => {
  it("states the coverage fraction rather than folding the gap into an 'Unknown' bucket", async () => {
    // 700 of 1000 total events (the `store`/platform dimension, which
    // is populated on every event) have no country — e.g. Stripe
    // `invoice.paid` renewals, per Task 3's verified matrix.
    arrange(
      response({
        platform: [
          { value: "STRIPE", label: "STRIPE", count: 700 },
          { value: "APP_STORE", label: "APP_STORE", count: 300 },
        ],
        country: [
          { value: "US", label: "US", count: 200 },
          { value: "DE", label: "DE", count: 100 },
        ],
        countryCoverage: { eventsWithCountry: 300, totalEvents: 1000 },
      }),
    );
    const note = await screen.findByTestId("country-coverage-note");
    expect(note).toHaveTextContent("30%");
    // No fabricated "Unknown" country row sitting alongside real ones.
    expect(screen.queryByText(/^unknown$/i)).toBeNull();
    // The prose names the gaps Task 3's matrix actually found. It listed
    // Stripe renewals and the pre-migration boundary but silently dropped
    // Google's voided-purchase refunds — an incomplete list presented as
    // if it were the whole story.
    expect(note).toHaveTextContent(/stripe/i);
    expect(note).toHaveTextContent(/voided-purchase/i);
    expect(note).toHaveTextContent(/before country tracking began/i);
  });

  it("renders each known country as its own row", async () => {
    arrange(
      response({
        platform: [{ value: "APP_STORE", label: "APP_STORE", count: 100 }],
        country: [{ value: "US", label: "US", count: 100 }],
        countryCoverage: { eventsWithCountry: 100, totalEvents: 100 },
      }),
    );
    expect(await screen.findByTestId("country-row-US")).toBeInTheDocument();
  });

  it("states full coverage, not a partial warning, when every event has a country", async () => {
    arrange(
      response({
        platform: [{ value: "APP_STORE", label: "APP_STORE", count: 100 }],
        country: [{ value: "US", label: "US", count: 100 }],
        countryCoverage: { eventsWithCountry: 100, totalEvents: 100 },
      }),
    );
    const note = await screen.findByTestId("country-coverage-note");
    expect(note).toHaveTextContent(/every event/i);
  });

  // Regression (final-fix-wave FIX 1): coverage used to be computed by
  // summing `country[].count`, which the API caps at 50 rows because it
  // also feeds a dropdown. A worldwide Apple-only project — full coverage
  // by the store matrix — therefore rendered a partial-coverage warning
  // naming Stripe and a pre-migration boundary that do not apply to it.
  it("states full coverage for a project with more distinct countries than the dropdown cap", async () => {
    arrange(
      response({
        platform: [{ value: "APP_STORE", label: "APP_STORE", count: 6000 }],
        // What the API can return: the top 50 only, 5000 of the 6000.
        country: manyCountries(50, 100),
        // What the uncapped aggregate says: every event has a country.
        countryCoverage: { eventsWithCountry: 6000, totalEvents: 6000 },
      }),
    );
    const note = await screen.findByTestId("country-coverage-note");
    expect(note).toHaveTextContent(/every event/i);
    expect(note).not.toHaveTextContent("83%");
  });

  it("shows an empty state, not a coverage note, when there is no revenue at all in the window", async () => {
    arrange(response());
    expect(await screen.findByTestId("country-coverage-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("country-coverage-note")).toBeNull();
  });

  it("states 0% coverage rather than hiding the gap when revenue exists but none has a country", async () => {
    // All-Stripe-renewals window: events exist, none carry a country.
    arrange(
      response({
        platform: [{ value: "STRIPE", label: "STRIPE", count: 500 }],
        country: [],
        countryCoverage: { eventsWithCountry: 0, totalEvents: 500 },
      }),
    );
    const note = await screen.findByTestId("country-coverage-note");
    expect(note).toHaveTextContent("0%");
    expect(
      await screen.findByTestId("country-coverage-no-known"),
    ).toBeInTheDocument();
  });
});
