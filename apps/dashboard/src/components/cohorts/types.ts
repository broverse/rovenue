export type RetentionMetric = "retention" | "revenue" | "count";

export type LtvCurve = {
  label: string;
  points: ReadonlyArray<number | null>;
  color: "primary" | "violet" | "success" | "warning";
};

export type CountryBreakdown = {
  country: string;
  users: number;
  w4: number;
  ltv: number;
  churn: number;
  delta: string;
};

export type SyncDestinationStatus = "on" | "off";

export type SyncDestination = {
  id: "metaAds" | "tiktokAds" | "experiments" | "featureFlag";
  status: SyncDestinationStatus;
  dot: "primary" | "success" | "warning" | "danger" | "violet" | "muted";
  state: { kind: "syncedAgo"; ago: string }
       | { kind: "notSynced" }
       | { kind: "activeCount"; count: number }
       | { kind: "ruleReferences"; count: number };
};

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
