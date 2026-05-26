export type RetentionMetric = "retention" | "revenue" | "count";

export type CohortMember = {
  id: string;
  initials: string;
  name: string;
};

export type Condition = {
  attribute: string;
  op: string;
  value: string;
  trailing?: { op: string; value: string };
};
