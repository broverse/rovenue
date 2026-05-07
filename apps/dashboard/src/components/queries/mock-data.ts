import type {
  QueryLogEntry,
  QueryPlanNode,
  RecentRun,
  SavedQuery,
  SchemaTable,
  SqlLine,
} from "./types";

const MRR_BY_COUNTRY_SQL: ReadonlyArray<SqlLine> = [
  ["cm", "-- MRR breakdown by country, last 30 days"],
  ["cm", "-- Owner: revenue@rovenue.dev · Refresh: hourly"],
  ["op", ""],
  ["kw", "SELECT", "  ", "fn", "country_code", "op", ","],
  ["op", "  ", "fn", "COUNT", "op", "(", "kw", "DISTINCT", " ", "fn", "subscriber_id", "op", ")", " ", "kw", "AS", " ", "id", "subs", "op", ","],
  ["op", "  ", "fn", "SUM", "op", "(", "fn", "mrr_usd", "op", ")", " ", "kw", "AS", " ", "id", "mrr_total", "op", ","],
  ["op", "  ", "fn", "AVG", "op", "(", "fn", "mrr_usd", "op", ")", " ", "kw", "AS", " ", "id", "arpu", "op", ","],
  ["op", "  ", "fn", "PERCENTILE_CONT", "op", "(", "nm", "0.5", "op", ") ", "kw", "WITHIN GROUP", " ", "op", "(", "kw", "ORDER BY", " ", "fn", "ltv_usd", "op", ")", " ", "kw", "AS", " ", "id", "p50_ltv"],
  ["kw", "FROM", " ", "fn", "subscriptions"],
  ["kw", "WHERE", " ", "fn", "status", " ", "op", "=", " ", "st", "'active'"],
  ["op", "  ", "kw", "AND", " ", "fn", "started_at", " ", "op", ">=", " ", "fn", "NOW", "op", "() - ", "kw", "INTERVAL", " ", "st", "'30 days'"],
  ["kw", "GROUP BY", " ", "fn", "country_code"],
  ["kw", "ORDER BY", " ", "id", "mrr_total", " ", "kw", "DESC"],
  ["kw", "LIMIT", " ", "nm", "12", "op", ";"],
];

export const SAVED_QUERIES: ReadonlyArray<SavedQuery> = [
  {
    id: "mrr_by_country",
    name: "MRR by country (last 30d)",
    folder: "revenue",
    durationMs: 184,
    rowCount: 12,
    bytesScanned: "14.2 MB",
    rowsScanned: 482104,
    sql: MRR_BY_COUNTRY_SQL,
    columns: [
      { name: "country_code", type: "string" },
      { name: "subs", type: "int" },
      { name: "mrr_total", type: "numeric" },
      { name: "arpu", type: "numeric" },
      { name: "p50_ltv", type: "numeric" },
    ],
    rows: [
      ["US", 18421, 482109, 26.18, 312.4],
      ["DE", 9112, 218404, 23.97, 287.1],
      ["GB", 7204, 178291, 24.74, 295.2],
      ["JP", 6188, 142008, 22.95, 268.9],
      ["FR", 4901, 109842, 22.41, 251.3],
      ["CA", 4204, 102194, 24.31, 281.4],
      ["AU", 3812, 91402, 23.98, 274.2],
      ["BR", 3601, 64420, 17.89, 198.5],
      ["NL", 2918, 71204, 24.4, 278.8],
      ["ES", 2640, 58112, 22.01, 244.1],
      ["IT", 2412, 51920, 21.53, 236.4],
      ["MX", 2218, 39402, 17.76, 192.2],
    ],
  },
  { id: "trial_funnel", name: "Trial → paid conversion funnel", folder: "revenue", durationMs: 612, rowCount: 7 },
  { id: "cohort_retention", name: "Weekly cohort retention", folder: "retention", durationMs: 1402, rowCount: 84 },
  { id: "refund_anomalies", name: "Refund anomalies (z-score)", folder: "anomalies", durationMs: 891, rowCount: 22 },
  { id: "arpu_segment", name: "ARPU by acquisition channel", folder: "revenue", durationMs: 322, rowCount: 14 },
  { id: "ltv_30d", name: "LTV at day 30 by product", folder: "revenue", durationMs: 540, rowCount: 18 },
  { id: "churn_predict", name: "Churn risk: high-value subscribers", folder: "retention", durationMs: 2104, rowCount: 412 },
  { id: "ios_vs_android", name: "iOS vs Android renewal rate", folder: "platform", durationMs: 412, rowCount: 6 },
  { id: "promo_attribution", name: "Promo code → 90d revenue", folder: "marketing", durationMs: 728, rowCount: 32 },
  { id: "fx_impact", name: "FX impact on reported MRR", folder: "finance", durationMs: 224, rowCount: 9 },
];

export const SAVED_QUERY_BY_ID: Readonly<Record<string, SavedQuery>> =
  SAVED_QUERIES.reduce<Record<string, SavedQuery>>((acc, q) => {
    acc[q.id] = q;
    return acc;
  }, {});

export const PINNED_QUERY_IDS: ReadonlyArray<string> = [
  "mrr_by_country",
  "cohort_retention",
  "refund_anomalies",
];

export const REVENUE_QUERY_IDS: ReadonlyArray<string> = [
  "arpu_segment",
  "ltv_30d",
  "fx_impact",
  "trial_funnel",
];

export const RETENTION_PLATFORM_QUERY_IDS: ReadonlyArray<string> = [
  "churn_predict",
  "ios_vs_android",
  "promo_attribution",
];

export const RECENT_RUNS: ReadonlyArray<RecentRun> = [
  { id: "r1", queryId: "mrr_by_country", whenKey: "minutesAgo_2", ms: 184, status: "ok" },
  { id: "r2", queryId: "cohort_retention", whenKey: "minutesAgo_14", ms: 1402, status: "ok" },
  { id: "r3", queryId: "churn_predict", whenKey: "hoursAgo_1", ms: 2104, status: "warn" },
  { id: "r4", queryId: "refund_anomalies", whenKey: "hoursAgo_2", ms: 891, status: "ok" },
  { id: "r5", queryId: "fx_impact", whenKey: "hoursAgo_4", ms: 0, status: "err" },
  { id: "r6", queryId: "arpu_segment", whenKey: "yesterday", ms: 322, status: "ok" },
  { id: "r7", queryId: "ios_vs_android", whenKey: "yesterday", ms: 412, status: "ok" },
];

export const SCHEMA_TABLES: ReadonlyArray<SchemaTable> = [
  {
    name: "subscriptions",
    rows: "482K",
    columns: [
      { name: "id", type: "uuid", pk: true },
      { name: "subscriber_id", type: "uuid" },
      { name: "product_id", type: "string" },
      { name: "status", type: "enum" },
      { name: "platform", type: "enum" },
      { name: "country_code", type: "string" },
      { name: "started_at", type: "timestamp" },
      { name: "expires_at", type: "timestamp" },
      { name: "mrr_usd", type: "numeric" },
      { name: "ltv_usd", type: "numeric" },
      { name: "is_trial", type: "bool" },
    ],
  },
  {
    name: "transactions",
    rows: "8.4M",
    columns: [
      { name: "id", type: "uuid", pk: true },
      { name: "subscription_id", type: "uuid" },
      { name: "amount_usd", type: "numeric" },
      { name: "currency", type: "string" },
      { name: "occurred_at", type: "timestamp" },
      { name: "kind", type: "enum" },
    ],
  },
  {
    name: "subscribers",
    rows: "124K",
    columns: [
      { name: "id", type: "uuid", pk: true },
      { name: "email", type: "string" },
      { name: "created_at", type: "timestamp" },
      { name: "channel", type: "string" },
      { name: "platform_first", type: "enum" },
    ],
  },
  {
    name: "events",
    rows: "38.2M",
    columns: [
      { name: "id", type: "ulid", pk: true },
      { name: "type", type: "string" },
      { name: "subscriber_id", type: "uuid" },
      { name: "occurred_at", type: "timestamp" },
      { name: "payload", type: "jsonb" },
    ],
  },
  {
    name: "experiments_assignments",
    rows: "604K",
    columns: [
      { name: "subscriber_id", type: "uuid" },
      { name: "experiment_id", type: "string" },
      { name: "variant", type: "string" },
      { name: "assigned_at", type: "timestamp" },
    ],
  },
  {
    name: "credits_ledger",
    rows: "2.1M",
    columns: [
      { name: "id", type: "uuid", pk: true },
      { name: "subscriber_id", type: "uuid" },
      { name: "delta", type: "numeric" },
      { name: "reason", type: "enum" },
      { name: "occurred_at", type: "timestamp" },
    ],
  },
];

export const AI_SUGGESTIONS: ReadonlyArray<string> = [
  "addMomDelta",
  "filterIos",
  "convertWeekly",
  "groupByProduct",
  "limitTopFive",
];

export const QUERY_PLAN: ReadonlyArray<QueryPlanNode> = [
  { depth: 0, op: "Sort", cost: "12.4ms", rows: "12", detail: "mrr_total DESC LIMIT 12" },
  { depth: 1, op: "Aggregate", cost: "88.2ms", rows: "198", detail: "group by country_code, partial+merge" },
  { depth: 2, op: "Filter", cost: "14.1ms", rows: "482,104", detail: "status='active' AND started_at >= now()-30d" },
  { depth: 2, op: "Index Scan", cost: "69.4ms", rows: "8,201,442", detail: "subscriptions_idx_started_at (BRIN)" },
];

export const QUERY_LOGS: ReadonlyArray<QueryLogEntry> = [
  { ts: "14:42:18.012", level: "info", message: "Query parsed and validated" },
  { ts: "14:42:18.018", level: "info", message: "Plan generated · 4 nodes" },
  { ts: "14:42:18.024", level: "info", message: "Cache HIT (signature 2m ttl)" },
  { ts: "14:42:18.196", level: "info", message: "12 rows materialized · 14.2 MB scanned" },
  { ts: "14:42:18.198", level: "info", message: "Result returned to client" },
];
