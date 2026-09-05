import { describe, expect, test } from "vitest";
import { buildStandingsQuery } from "./standings-query";

describe("buildStandingsQuery", () => {
  test("TOP_SPENDERS sums amountUsd from raw_revenue_events", () => {
    const { sql } = buildStandingsQuery("TOP_SPENDERS", null);
    expect(sql).toContain("rovenue.raw_revenue_events");
    expect(sql).toContain("amountUsd");
  });

  test("TOP_CONSUMERS sums debited credits from raw_credit_ledger", () => {
    const { sql } = buildStandingsQuery("TOP_CONSUMERS", null);
    expect(sql).toContain("rovenue.raw_credit_ledger");
    expect(sql).toContain("amount < 0");
  });

  test("TOP_CONSUMERS scopes to one currency when given", () => {
    const { sql } = buildStandingsQuery("TOP_CONSUMERS", "cur_1");
    expect(sql).toContain("{currencyId:String}");
  });

  test("TOP_CONSUMERS with no currency does not reference the parameter", () => {
    // Passing an unused parameter to ClickHouse is an error, not a no-op.
    const { sql } = buildStandingsQuery("TOP_CONSUMERS", null);
    expect(sql).not.toContain("{currencyId:String}");
  });

  test("every query orders deterministically", () => {
    // Ties must break the same way in the frozen snapshot and in
    // /current, or a subscriber's rank appears to change on refresh.
    for (const metric of ["TOP_SPENDERS", "TOP_CONSUMERS"] as const) {
      expect(buildStandingsQuery(metric, null).sql).toContain(
        "subscriberId ASC",
      );
    }
  });
});
