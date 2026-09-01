// =============================================================
// readFilterOptions — country dimension (Task 2, 2026-09-01 plan)
// =============================================================
//
// `country` used to return `[]` unconditionally (no real column backed
// it — see charts.ts's doc comment). Migration 0023 adds
// `raw_revenue_events.country`, sourced from the store's own
// per-transaction value (never a subscriber attribute). This proves
// `readFilterOptions` now queries that real column and shapes whatever
// ClickHouse returns into the filter-option list, mirroring the
// existing `platform` dimension — same mocked-ClickHouse technique as
// charts.paywall.test.ts (the schema-contract integration test already
// proves the SQL is valid against the real schema; this proves the
// TypeScript shaping).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isClickHouseConfiguredMock = vi.fn();
const queryAnalyticsMock = vi.fn();

vi.mock("../../lib/clickhouse", () => ({
  isClickHouseConfigured: (...args: unknown[]) =>
    isClickHouseConfiguredMock(...args),
  queryAnalytics: (...args: unknown[]) => queryAnalyticsMock(...args),
  ClickHouseUnavailableError: class ClickHouseUnavailableError extends Error {},
}));

import { readFilterOptions } from "./charts";

const FROZEN_NOW = new Date("2026-07-02T12:00:00.000Z");

describe("readFilterOptions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    isClickHouseConfiguredMock.mockReset().mockReturnValue(true);
    queryAnalyticsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the store-supplied country values ClickHouse reports, alongside platform", async () => {
    queryAnalyticsMock
      .mockResolvedValueOnce([{ value: "APP_STORE", c: "42" }]) // platform
      .mockResolvedValueOnce([
        { value: "USA", c: "30" },
        { value: "GBR", c: "12" },
      ]) // country
      .mockResolvedValueOnce([{ known: "42", total: "42" }]); // coverage

    const res = await readFilterOptions("proj_1", 28);

    expect(res.platform).toEqual([
      { value: "APP_STORE", label: "APP_STORE", count: 42 },
    ]);
    expect(res.country).toEqual([
      { value: "USA", label: "USA", count: 30 },
      { value: "GBR", label: "GBR", count: 12 },
    ]);

    // The country query hits the real `country` column, not a
    // non-existent `subscriberCountry`/product-group style stand-in.
    const [, countrySql] = queryAnalyticsMock.mock.calls[1] as [
      string,
      string,
    ];
    expect(countrySql).toContain("country");
    expect(countrySql).not.toContain("subscriberCountry");
  });

  it("returns an empty country list when ClickHouse has none for the window (not an error)", async () => {
    queryAnalyticsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ known: "0", total: "0" }]);

    const res = await readFilterOptions("proj_1", 28);

    expect(res.country).toEqual([]);
    expect(res.countryCoverage).toEqual({
      eventsWithCountry: 0,
      totalEvents: 0,
    });
    expect(queryAnalyticsMock).toHaveBeenCalledTimes(3);
  });

  // Regression: coverage used to be derived by the DASHBOARD summing
  // `country[].count` and dividing by the sum of `platform[].count`.
  // `country` is a DROPDOWN feed capped at DISTINCT_OPTION_LIMIT rows,
  // so a project selling in more than that many storefronts had its
  // coverage understated — a worldwide Apple-only project with full
  // coverage rendered "known for 94% of events", inventing a gap that
  // does not exist for it. Coverage now comes from its own unlimited
  // aggregate over the same window.
  it("computes country coverage from an unlimited aggregate, not by summing the display-capped country list", async () => {
    const cappedCountryRows = Array.from({ length: 50 }, (_, i) => ({
      value: `C${i}`,
      c: "10",
    })); // 500 events across the 50 rows the dropdown is allowed to show

    queryAnalyticsMock
      .mockResolvedValueOnce([{ value: "APP_STORE", c: "900" }]) // platform
      .mockResolvedValueOnce(cappedCountryRows) // country (display-capped)
      .mockResolvedValueOnce([{ known: "900", total: "900" }]); // coverage

    const res = await readFilterOptions("proj_1", 28);

    // 900, not the 500 the truncated display list sums to.
    expect(res.countryCoverage).toEqual({
      eventsWithCountry: 900,
      totalEvents: 900,
    });
    expect(res.country).toHaveLength(50);

    const [, coverageSql] = queryAnalyticsMock.mock.calls[2] as [
      string,
      string,
    ];
    expect(coverageSql).toContain("countIf(country != '')");
    // The whole point: no row cap on the aggregate.
    expect(coverageSql).not.toContain("LIMIT");
  });

  it("reports zero coverage rather than throwing when ClickHouse returns no aggregate row", async () => {
    queryAnalyticsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await readFilterOptions("proj_1", 28);

    expect(res.countryCoverage).toEqual({
      eventsWithCountry: 0,
      totalEvents: 0,
    });
  });
});
