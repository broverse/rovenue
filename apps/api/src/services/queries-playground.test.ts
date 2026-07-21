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

  it("rejects table functions that bypass project scoping / reach egress", () => {
    // merge() reads across every project's tables (cross-tenant).
    expect(() =>
      validatePlaygroundSql("SELECT * FROM merge('rovenue','^raw_revenue_events$')"),
    ).toThrow(/Table functions/);
    // url() → SSRF to the cloud-metadata endpoint.
    expect(() =>
      validatePlaygroundSql(
        "SELECT * FROM url('http://169.254.169.254/latest/meta-data/','CSV','c String')",
      ),
    ).toThrow(/Table functions/);
    // file() → local filesystem read.
    expect(() =>
      validatePlaygroundSql("SELECT * FROM file('/etc/passwd','LineAsString','l String')"),
    ).toThrow(/Table functions/);
    // remote() / s3() are likewise blocked.
    expect(() =>
      validatePlaygroundSql(
        "SELECT * FROM remote('10.0.0.1:9000','rovenue','raw_revenue_events')",
      ),
    ).toThrow(/Table functions/);
    expect(() =>
      validatePlaygroundSql("SELECT * FROM s3('https://x/y.csv','CSV','c String')"),
    ).toThrow();
  });

  it("does not false-positive on columns/CTEs that merely share a function name", () => {
    // `url` as a column selection (not a function call) is fine.
    expect(() =>
      validatePlaygroundSql("SELECT url FROM raw_revenue_events"),
    ).not.toThrow();
    // A CTE named like a table function, referenced without `(`, is fine.
    expect(() =>
      validatePlaygroundSql("WITH merge AS (SELECT 1 AS n) SELECT n FROM merge"),
    ).not.toThrow();
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
