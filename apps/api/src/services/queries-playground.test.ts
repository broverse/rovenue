import { describe, it, expect } from "vitest";
import {
  QueryValidationError,
  buildProjectScopeFilters,
  validatePlaygroundSql,
} from "./queries-playground";

describe("validatePlaygroundSql", () => {
  it("accepts a plain SELECT with no projectId reference", () => {
    // Project isolation is now injected server-side, so the body no
    // longer needs to mention {projectId:String}.
    expect(() =>
      validatePlaygroundSql("SELECT count() FROM raw_revenue_events"),
    ).not.toThrow();
  });

  it("accepts a leading-comment + WITH query", () => {
    expect(() =>
      validatePlaygroundSql("-- daily\nWITH x AS (SELECT 1) SELECT * FROM x"),
    ).not.toThrow();
  });

  it("rejects an empty body", () => {
    expect(() => validatePlaygroundSql("   ")).toThrow(QueryValidationError);
  });

  it("rejects non-SELECT statements", () => {
    expect(() => validatePlaygroundSql("SHOW TABLES")).toThrow(
      /SELECT \/ WITH/,
    );
  });

  it("rejects DML / DDL keywords", () => {
    expect(() =>
      validatePlaygroundSql("SELECT 1; DROP TABLE raw_revenue_events"),
    ).toThrow();
    expect(() =>
      validatePlaygroundSql("INSERT INTO t VALUES (1)"),
    ).toThrow();
  });

  it("rejects multi-statement bodies", () => {
    expect(() =>
      validatePlaygroundSql("SELECT 1 FROM raw_revenue_events; SELECT 2"),
    ).toThrow(/single SQL statement/);
  });

  it("rejects bodies over the size cap", () => {
    expect(() =>
      validatePlaygroundSql(`SELECT '${"a".repeat(16_001)}'`),
    ).toThrow(/16,000/);
  });
});

describe("buildProjectScopeFilters", () => {
  it("emits a ClickHouse Map literal scoping each table to projectId", () => {
    const map = buildProjectScopeFilters(
      ["raw_revenue_events", "mv_mrr_daily"],
      "prj_abc123",
    );
    expect(map.toString()).toBe(
      "{'rovenue.raw_revenue_events':'projectId = \\'prj_abc123\\''," +
        "'rovenue.mv_mrr_daily':'projectId = \\'prj_abc123\\''}",
    );
  });

  it("produces an empty map when there are no scoped tables", () => {
    expect(buildProjectScopeFilters([], "prj_abc123").toString()).toBe("{}");
  });

  it("rejects a projectId that could break out of the SQL literal", () => {
    expect(() =>
      buildProjectScopeFilters(["raw_revenue_events"], "x' OR '1'='1"),
    ).toThrow(QueryValidationError);
    expect(() =>
      buildProjectScopeFilters(["raw_revenue_events"], "a; DROP"),
    ).toThrow(/Invalid project identifier/);
  });
});
