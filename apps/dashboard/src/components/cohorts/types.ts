export type RetentionMetric = "retention" | "revenue" | "count";

export type Condition = {
  attribute: string;
  op: string;
  value: string;
  trailing?: { op: string; value: string };
};
