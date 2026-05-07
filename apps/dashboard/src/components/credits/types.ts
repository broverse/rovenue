export type CreditSource =
  | "purchase"
  | "bonus"
  | "consume"
  | "refund"
  | "expire"
  | "adjust";

export type LedgerScope = "all" | CreditSource;

export type LedgerEntry = {
  id: string;
  ts: string;
  user: string;
  uid: string;
  avatarColor: string;
  source: CreditSource;
  delta: number;
  balance: number;
  note: string;
  extId?: string;
};

export type CreditPack = {
  id: string;
  name: string;
  price: number;
  sold: number;
  share: number;
  color: string;
};

export type CreditBurner = {
  id: string;
  feature: string;
  description: string;
  cost: string;
  burnedM: number;
  pct: number;
};

export type VolumePoint = {
  d: number;
  issued: number;
  burned: number;
  net: number;
};

export type FlowBreakdown = {
  labelKey: string;
  value: string;
  tone?: "default" | "accent" | "warning" | "muted";
};

export type FlowNode = {
  id: "in" | "balance" | "out";
  titleKey: string;
  total: string;
  breakdown: ReadonlyArray<FlowBreakdown>;
};
