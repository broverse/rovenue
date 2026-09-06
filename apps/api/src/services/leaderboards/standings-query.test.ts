import { beforeEach, describe, expect, test, vi } from "vitest";

// queryStandings calls straight through to queryAnalytics; mock the module
// so this stays a unit test (no real ClickHouse) while leaving
// queryStandings's own signature untouched for the Task 4/5 callers.
const queryAnalyticsMock = vi.fn();
vi.mock("../../lib/clickhouse", () => ({
  queryAnalytics: (...args: unknown[]) => queryAnalyticsMock(...args),
}));

import { buildStandingsQuery, queryStandings } from "./standings-query";
import type { LeaderboardMetric } from "@rovenue/db";

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

  // --- Review follow-up: pin the per-table time column and its direction ---
  //
  // `raw_revenue_events` has no `createdAt` column at all (see
  // packages/db/clickhouse/migrations/0004_revenue_kafka_engine.sql); its
  // event-time column is `eventDate`. `raw_credit_ledger` does carry
  // `createdAt` (0005_credit_kafka_engine.sql). The original brief's prose
  // assumed both branches windowed on `createdAt` — wrong for TOP_SPENDERS.
  // These assertions pin the exact column *and* operator per branch, so a
  // wrong column or a swapped `>=`/`<` fails loudly instead of passing a
  // loose substring check.

  test("TOP_SPENDERS windows on eventDate — half-open, start inclusive, end exclusive", () => {
    const { sql } = buildStandingsQuery("TOP_SPENDERS", null);
    expect(sql).toContain("eventDate >= {startsAt:DateTime64(3)}");
    expect(sql).toContain("eventDate < {endsAt:DateTime64(3)}");
    // Would have caught the brief's wrong prose: raw_revenue_events has no
    // createdAt column.
    expect(sql).not.toContain("createdAt");
  });

  test("TOP_CONSUMERS windows on createdAt — half-open, start inclusive, end exclusive", () => {
    const { sql } = buildStandingsQuery("TOP_CONSUMERS", null);
    expect(sql).toContain("createdAt >= {startsAt:DateTime64(3)}");
    expect(sql).toContain("createdAt < {endsAt:DateTime64(3)}");
  });

  test("window direction cannot be swapped without breaking the check", () => {
    // Guards specifically against `>= endsAt` / `< startsAt`, or an
    // inclusive end (`<=`), sneaking in — both would double-count or drop
    // the boundary event.
    for (const [metric, column] of [
      ["TOP_SPENDERS", "eventDate"],
      ["TOP_CONSUMERS", "createdAt"],
    ] as const) {
      const { sql } = buildStandingsQuery(metric, null);
      expect(sql).not.toContain(`${column} >= {endsAt:DateTime64(3)}`);
      expect(sql).not.toContain(`${column} <= {endsAt:DateTime64(3)}`);
      expect(sql).not.toContain(`${column} < {startsAt:DateTime64(3)}`);
    }
  });

  // --- Review follow-up: pin the pieces lifted from the originals ---

  test("both queries carry FINAL, the projectId filter, and a LIMIT", () => {
    for (const metric of ["TOP_SPENDERS", "TOP_CONSUMERS"] as const) {
      const { sql } = buildStandingsQuery(metric, null);
      expect(sql).toContain("FINAL");
      expect(sql).toContain("projectId = {projectId:String}");
      expect(sql).toContain("LIMIT {limit:UInt32}");
    }
  });

  test("TOP_CONSUMERS keeps the HAVING clause that drops non-debiting subscribers", () => {
    const { sql } = buildStandingsQuery("TOP_CONSUMERS", null);
    expect(sql).toContain("HAVING sumIf(-amount, amount < 0) > 0");
  });
});

describe("queryStandings — parameter object", () => {
  beforeEach(() => {
    queryAnalyticsMock.mockReset().mockResolvedValue([]);
  });

  const startsAt = new Date("2026-09-01T00:00:00.000Z");
  const endsAt = new Date("2026-09-08T00:00:00.000Z");

  test.each([
    ["TOP_SPENDERS", null, false],
    // TOP_SPENDERS has no currency dimension; a currencyId argument must
    // be dropped even when the caller passes one, or ClickHouse gets a
    // parameter its SQL never references.
    ["TOP_SPENDERS", "cur_1", false],
    ["TOP_CONSUMERS", null, false],
    ["TOP_CONSUMERS", "cur_1", true],
  ] as const)(
    "metric=%s currencyId=%s -> params include currencyId: %s",
    async (
      metric: LeaderboardMetric,
      currencyId: string | null,
      shouldIncludeCurrencyId: boolean,
    ) => {
      await queryStandings({
        projectId: "proj_1",
        metric,
        currencyId,
        startsAt,
        endsAt,
        limit: 10,
      });

      expect(queryAnalyticsMock).toHaveBeenCalledTimes(1);
      const [projectId, sql, params] = queryAnalyticsMock.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];

      expect(projectId).toBe("proj_1");
      expect(Object.prototype.hasOwnProperty.call(params, "currencyId")).toBe(
        shouldIncludeCurrencyId,
      );
      // The args object handed to ClickHouse must agree with what the SQL
      // text itself declares — an extra bound param, or a missing one the
      // SQL references, is a ClickHouse error, not a no-op.
      expect(sql.includes("{currencyId:String}")).toBe(shouldIncludeCurrencyId);
      if (shouldIncludeCurrencyId) {
        expect(params.currencyId).toBe(currencyId);
      }

      expect(params.startsAt).toBe(startsAt);
      expect(params.endsAt).toBe(endsAt);
      expect(params.limit).toBe(10);
    },
  );
});
