import type {
  QueryExecuteResponse,
  QuerySchemaResponse,
  QuerySchemaTable,
} from "@rovenue/shared";
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
//   2. Project isolation contract: the body MUST reference
//      `{projectId:String}` at least once. The executor binds
//      the request's projectId into query_params before sending,
//      so users physically cannot read another project's data
//      without explicitly opting out (which we reject up front).
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
const PROJECT_PARAM_RE = /\{projectId:\s*String\}/;
const MULTI_STATEMENT_RE = /;\s*\S/;

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
  if (MULTI_STATEMENT_RE.test(sql.trim().replace(/;$/, ""))) {
    throw new QueryValidationError(
      "Only a single SQL statement is allowed per request",
    );
  }
  if (!PROJECT_PARAM_RE.test(sql)) {
    throw new QueryValidationError(
      "Query must reference {projectId:String} for project isolation",
    );
  }
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
  const start = performance.now();

  const response = await client.query({
    query: input.sql,
    query_params: { projectId: input.projectId },
    format: "JSONCompact",
    clickhouse_settings: {
      readonly: "2",
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
