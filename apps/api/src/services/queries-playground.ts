import type {
  QueryExecuteResponse,
  QuerySchemaResponse,
  QuerySchemaTable,
} from "@rovenue/shared";
import { SettingsMap } from "@clickhouse/client";
import {
  ClickHouseUnavailableError,
  getClickHouseClient,
  isClickHouseConfigured,
  queryAnalytics,
} from "../lib/clickhouse";

// =============================================================
// Queries playground service (Phase 4.5)
// =============================================================
//
// Sandboxed ClickHouse executor for the dashboard's queries
// page. Three layers of protection over the raw client:
//
//   1. Pre-flight regex screen: the SQL must look like a single
//      SELECT/WITH statement. Multi-statement bodies, DML, DDL
//      and procedural statements are rejected.
//
//   2. Project isolation, enforced server-side: rather than make
//      users hand-write `WHERE projectId = {projectId:String}`,
//      the executor injects a row filter into every project-scoped
//      table via ClickHouse's `additional_table_filters` setting.
//      ClickHouse ANDs that filter into each table scan, so a query
//      physically cannot read another project's rows — even one that
//      writes its own conflicting `projectId` predicate. See
//      `buildProjectScopeFilters` below.
//
//   3. ClickHouse session settings: `readonly = 2` (allow
//      SELECT/SHOW + session settings, no DDL/DML),
//      `max_execution_time`, `max_result_rows`,
//      `max_result_bytes`. The settings ride on the request,
//      so they apply per-call rather than to the shared client.

const MAX_EXECUTION_SECONDS = 8;
const MAX_RESULT_ROWS = 5_000;
const MAX_RESULT_BYTES = 32 * 1024 * 1024; // 32 MB

// Regex screen — matches a SELECT or WITH at the start of the
// trimmed body (allowing leading SQL comments) and rejects any
// trailing `;` followed by more SQL.
const VALID_LEAD_RE = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(select|with)\s/i;
const FORBIDDEN_KEYWORD_RE =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|detach|optimize|kill|system)\b/i;
// ClickHouse table functions read data OUTSIDE the analytics tables, so they
// bypass both `readonly = 2` (which only blocks writes) and the
// `additional_table_filters` project scoping (which only filters named
// `rovenue.*` tables). `merge()` reads across every project's tables; `url()`,
// `file()`, `remote()`, `s3()`, `mysql()` etc. reach internal services / the
// cloud-metadata endpoint / the local filesystem. Reject any of them as a
// function call. (Requiring the trailing `(` avoids false positives on a
// column or CTE that merely shares one of these names.) Durable enforcement is
// the REVOKE on the `rovenue_reader` ClickHouse user; this is defense-in-depth.
const FORBIDDEN_TABLE_FUNCTION_RE =
  /\b(url|urlCluster|file|fileCluster|remote|remoteSecure|cluster|clusterAllReplicas|merge|mysql|postgresql|mongodb|redis|sqlite|jdbc|odbc|hdfs|hdfsCluster|s3|s3Cluster|gcs|azureBlobStorage|azureBlobStorageCluster|deltaLake|hudi|iceberg|executable|input)\s*\(/i;
const MULTI_STATEMENT_RE = /;\s*\S/;

// Project IDs are cuid2 / prefixed identifiers — strictly
// [A-Za-z0-9_-]. We inline the id into the ClickHouse
// `additional_table_filters` setting (params are not substituted
// inside that setting), so reject anything that could break out of
// the single-quoted literal.
const PROJECT_ID_RE = /^[A-Za-z0-9_-]+$/;

export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

export function validatePlaygroundSql(sql: string): void {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new QueryValidationError("SQL body is required");
  }
  if (sql.length > 16_000) {
    throw new QueryValidationError("SQL exceeds the 16,000-character cap");
  }
  if (!VALID_LEAD_RE.test(sql)) {
    throw new QueryValidationError("Only SELECT / WITH queries are allowed");
  }
  if (FORBIDDEN_KEYWORD_RE.test(sql)) {
    throw new QueryValidationError(
      "Mutation / DDL keywords are not allowed in the playground",
    );
  }
  if (FORBIDDEN_TABLE_FUNCTION_RE.test(sql)) {
    throw new QueryValidationError(
      "Table functions (url, file, remote, merge, s3, …) are not allowed in the playground",
    );
  }
  if (MULTI_STATEMENT_RE.test(sql.trim().replace(/;$/, ""))) {
    throw new QueryValidationError(
      "Only a single SQL statement is allowed per request",
    );
  }
  // No `{projectId:String}` requirement: project isolation is now
  // enforced server-side via `additional_table_filters` (see
  // buildProjectScopeFilters), so users no longer hand-scope queries.
}

// =============================================================
// Automatic project scoping
// =============================================================
//
// The set of project-scoped tables (those carrying a `projectId`
// column) is discovered from system.columns and cached briefly, so
// new analytics tables are covered automatically without a code
// change. ClickHouse ignores filter entries for tables that don't
// appear in a given query, so over-listing is harmless.

const SCOPED_TABLES_TTL_MS = 5 * 60_000;
let scopedTablesCache: { tables: string[]; at: number } | null = null;

interface ChTableRow {
  data: Array<[string]>;
}

async function getProjectScopedTables(): Promise<string[]> {
  const now = Date.now();
  if (scopedTablesCache && now - scopedTablesCache.at < SCOPED_TABLES_TTL_MS) {
    return scopedTablesCache.tables;
  }
  const client = getClickHouseClient();
  const res = await client.query({
    query:
      "SELECT table FROM system.columns " +
      "WHERE database = 'rovenue' AND name = 'projectId' GROUP BY table",
    format: "JSONCompact",
  });
  const body = (await res.json()) as ChTableRow;
  const tables = body.data.map((row) => row[0]);
  scopedTablesCache = { tables, at: now };
  return tables;
}

/**
 * Builds the `additional_table_filters` map that scopes every
 * project-bearing table to `projectId`. Exported for tests.
 *
 * The id is inlined as a single-quoted SQL literal (params are not
 * substituted inside this setting). PROJECT_ID_RE guarantees the id
 * carries no quotes of its own; the `\'` escapes are required by the
 * ClickHouse Map-literal text format.
 */
export function buildProjectScopeFilters(
  tables: ReadonlyArray<string>,
  projectId: string,
): SettingsMap {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new QueryValidationError("Invalid project identifier");
  }
  const record: Record<string, string> = {};
  for (const table of tables) {
    record[`rovenue.${table}`] = `projectId = \\'${projectId}\\'`;
  }
  return SettingsMap.from(record);
}

/** Test seam: clear the cached scoped-table list. */
export function __resetScopedTablesCache(): void {
  scopedTablesCache = null;
}

// =============================================================
// Execute
// =============================================================

interface JsonCompactResponse {
  meta: Array<{ name: string; type: string }>;
  data: unknown[][];
  rows: number;
  rows_before_limit_at_least?: number;
  statistics?: { elapsed: number };
}

export interface ExecutePlaygroundQueryInput {
  projectId: string;
  sql: string;
}

export async function executePlaygroundQuery(
  input: ExecutePlaygroundQueryInput,
): Promise<QueryExecuteResponse> {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }
  validatePlaygroundSql(input.sql);

  const client = getClickHouseClient();
  const scopedTables = await getProjectScopedTables();
  const projectScope = buildProjectScopeFilters(scopedTables, input.projectId);
  const start = performance.now();

  const response = await client.query({
    query: input.sql,
    // `query_params` keeps older saved queries that still reference
    // `{projectId:String}` working; new queries are scoped by the
    // `additional_table_filters` below and need no param.
    query_params: { projectId: input.projectId },
    format: "JSONCompact",
    clickhouse_settings: {
      readonly: "2",
      additional_table_filters: projectScope,
      max_execution_time: MAX_EXECUTION_SECONDS,
      max_result_rows: String(MAX_RESULT_ROWS),
      max_result_bytes: String(MAX_RESULT_BYTES),
      // Halt rather than degrade silently when the cap is hit so
      // the dashboard can show "truncated" instead of partial
      // data with no signal.
      result_overflow_mode: "break",
    },
  });

  const body = (await response.json()) as JsonCompactResponse;
  const durationMs = Math.round(performance.now() - start);
  const truncated = body.rows >= MAX_RESULT_ROWS;

  return {
    columns: body.meta.map((m) => ({ name: m.name, type: m.type })),
    rows: body.data,
    rowCount: body.rows,
    truncated,
    durationMs,
  };
}

// =============================================================
// Schema introspection
// =============================================================
//
// Returns the curated set of tables + columns the playground
// exposes. We surface the `rovenue.raw_*` event tables, the MV
// targets, and the dashboard reference tables; everything else
// stays hidden so users don't run accidental admin reads against
// internal tables.

const EXPOSED_TABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^raw_revenue_events$/,
  /^raw_credit_ledger$/,
  /^raw_exposures$/,
  /^mv_/,
];

interface ChSchemaRow {
  table: string;
  name: string;
  type: string;
}

interface ChCountRow {
  table: string;
  total: string;
}

export async function readPlaygroundSchema(
  projectId: string,
): Promise<QuerySchemaResponse> {
  if (!isClickHouseConfigured()) {
    throw new ClickHouseUnavailableError();
  }

  // Columns
  const cols = await queryAnalytics<ChSchemaRow>(
    projectId,
    `
      SELECT
        table,
        name,
        type
      FROM system.columns
      WHERE database = 'rovenue'
      ORDER BY table, position
    `,
  );

  const byTable = new Map<string, QuerySchemaTable>();
  for (const c of cols) {
    if (!EXPOSED_TABLE_PATTERNS.some((re) => re.test(c.table))) continue;
    let t = byTable.get(c.table);
    if (!t) {
      t = { name: c.table, columns: [], rowEstimate: null };
      byTable.set(c.table, t);
    }
    t.columns.push({ name: c.name, type: c.type });
  }

  // Row estimates from system.parts — cheap aggregate read.
  const counts = await queryAnalytics<ChCountRow>(
    projectId,
    `
      SELECT
        table,
        toString(sum(rows))                          AS total
      FROM system.parts
      WHERE database = 'rovenue' AND active
      GROUP BY table
    `,
  );
  for (const row of counts) {
    const t = byTable.get(row.table);
    if (!t) continue;
    t.rowEstimate = Number(row.total);
  }

  const tables = [...byTable.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { database: "rovenue", tables };
}

export const __playgroundConstants = {
  MAX_EXECUTION_SECONDS,
  MAX_RESULT_ROWS,
  MAX_RESULT_BYTES,
};
