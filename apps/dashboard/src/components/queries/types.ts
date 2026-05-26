export type QueryFolder =
  | "revenue"
  | "retention"
  | "anomalies"
  | "platform"
  | "marketing"
  | "finance";

export type ColumnType =
  | "string"
  | "int"
  | "numeric"
  | "uuid"
  | "enum"
  | "bool"
  | "timestamp"
  | "ulid"
  | "jsonb";

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

export type QueryResultTab = "table" | "chart";
