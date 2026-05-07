export type SqlTokenKind =
  | "kw"
  | "fn"
  | "st"
  | "nm"
  | "cm"
  | "pn"
  | "op"
  | "id";

/**
 * Inline-styled SQL fragment — alternating `[kind, text, kind, text, ...]`
 * pairs render as colored `<span>`s in the editor. A leading `["cm", "..."]`
 * pair is treated as a full-line comment.
 */
export type SqlLineSegment = readonly [SqlTokenKind, string];
export type SqlLine = ReadonlyArray<string>;

export type QueryFolder =
  | "revenue"
  | "retention"
  | "anomalies"
  | "platform"
  | "marketing"
  | "finance";

export type QueryRunStatus = "ok" | "warn" | "err";

export type ColumnType = "string" | "int" | "numeric" | "uuid" | "enum" | "bool" | "timestamp" | "ulid" | "jsonb";

export type SavedQueryColumn = {
  name: string;
  type: ColumnType;
};

export type SavedQuery = {
  id: string;
  name: string;
  folder: QueryFolder;
  durationMs: number;
  rowCount?: number;
  bytesScanned?: string;
  rowsScanned?: number;
  sql?: ReadonlyArray<SqlLine>;
  columns?: ReadonlyArray<SavedQueryColumn>;
  rows?: ReadonlyArray<ReadonlyArray<string | number>>;
};

export type SchemaColumn = {
  name: string;
  type: ColumnType;
  pk?: boolean;
};

export type SchemaTable = {
  name: string;
  rows: string;
  columns: ReadonlyArray<SchemaColumn>;
};

export type RecentRun = {
  id: string;
  queryId: string;
  whenKey: string;
  ms: number;
  status: QueryRunStatus;
};

export type QueryResultTab = "table" | "chart" | "plan" | "logs";

export type QueryPlanNode = {
  depth: number;
  op: string;
  cost: string;
  rows: string;
  detail: string;
};

export type QueryLogEntry = {
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
};
