export type FlagType = "bool" | "string" | "number" | "json";

export type FlagEnv = "prod" | "staging" | "development";

export type FlagScope = "all" | "on" | "off" | "killed" | "experiment";

export type Condition = {
  attribute: string;
  op: string;
  value: string;
};

export type Rule =
  | {
      type: "match";
      conditions: ReadonlyArray<Condition>;
      serve: string;
      rolloutPct?: number;
    }
  | {
      type: "default";
      serve: string;
    };

export type Variant = {
  value: string;
  pct: number;
  color: string;
};

export type HistoryEntry = {
  when: string;
  action: string;
  detail: string;
  tone: "primary" | "success" | "danger" | "neutral";
};

export type FeatureFlag = {
  key: string;
  type: FlagType;
  description: string;
  enabled: boolean;
  killed: boolean;
  rolloutPct: number;
  env: FlagEnv;
  evalRate: number;
  evals24h: number;
  lastChanged: string;
  by: string;
  tags: ReadonlyArray<string>;
  linkedExperiment?: string;
  rules: ReadonlyArray<Rule>;
  variants?: ReadonlyArray<Variant>;
  history: ReadonlyArray<HistoryEntry>;
};
