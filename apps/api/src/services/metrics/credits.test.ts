import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getCreditBurnDaily (task 5): re-shapes readVolume's existing daily CH
// query into charts.ts's `credit_burn` chart id. No new SQL — this test
// mocks queryAnalytics directly (the same seam charts.paywall.test.ts
// uses) to prove the re-shaping and the sign normalisation, not the SQL
// itself (that's schema-validated for real in
// schema-contract.integration.test.ts).

const queryAnalyticsMock = vi.fn();
vi.mock("../../lib/clickhouse", () => ({
  isClickHouseConfigured: vi.fn().mockReturnValue(true),
  queryAnalytics: (...args: unknown[]) => queryAnalyticsMock(...args),
  ClickHouseUnavailableError: class ClickHouseUnavailableError extends Error {},
}));

import { getCreditBurnDaily } from "./credits";

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-07-02T23:59:59.999Z");
const WINDOW = { from: FROM, to: TO, days: 2 };

describe("getCreditBurnDaily", () => {
  beforeEach(() => {
    queryAnalyticsMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports the real convention: v_credit_consumption_daily's `burned` already arrives positive", async () => {
    // debited_credits = sumIf(-amount, amount < 0) — SPEND/EXPIRE rows
    // store a negative ledger amount, negated before summing, so this is
    // the shape production ClickHouse actually returns.
    queryAnalyticsMock.mockResolvedValueOnce([
      { bucket: "2026-07-01", issued: "10", burned: "4", net: "6" },
    ]);
    const rows = await getCreditBurnDaily("proj_1", WINDOW);
    expect(rows.find((r) => r.day === "2026-07-01")?.n).toBe(4);
  });

  it("normalises defensively if a negative `burned` ever arrived", async () => {
    // Not the observed convention (see test above) — this guards against
    // a future change to the view silently reintroducing a negative
    // flow, which would otherwise render as a burn chart dipping below
    // zero.
    queryAnalyticsMock.mockResolvedValueOnce([
      { bucket: "2026-07-01", issued: "10", burned: "-4", net: "6" },
    ]);
    const rows = await getCreditBurnDaily("proj_1", WINDOW);
    expect(rows.find((r) => r.day === "2026-07-01")?.n).toBe(4);
  });

  it("pads every day in the window, a day absent from CH is 0", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([]);
    const rows = await getCreditBurnDaily("proj_1", WINDOW);
    expect(rows).toEqual([
      { day: "2026-07-01", n: 0 },
      { day: "2026-07-02", n: 0 },
    ]);
  });

  it("scopes the query by currencyId when provided", async () => {
    queryAnalyticsMock.mockResolvedValueOnce([]);
    await getCreditBurnDaily("proj_1", WINDOW, "cur_gld");
    const [, , params] = queryAnalyticsMock.mock.calls[0] as [
      string,
      string,
      { currencyId?: string },
    ];
    expect(params.currencyId).toBe("cur_gld");
  });
});
