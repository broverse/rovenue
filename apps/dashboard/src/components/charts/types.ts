export type ChartCategory =
  | "revenue"
  | "growth"
  | "retention"
  | "conversion"
  | "credits"
  | "custom";

export type ChartType = "line" | "area" | "bar";

export type RangeOption = "1M" | "3M" | "6M" | "12M" | "YTD" | "All";

export type SeriesPoint = number;

export type MrrSeries = {
  current: ReadonlyArray<SeriesPoint>;
  prev: ReadonlyArray<SeriesPoint>;
  newMrr: ReadonlyArray<SeriesPoint>;
  expansion: ReadonlyArray<SeriesPoint>;
  contraction: ReadonlyArray<SeriesPoint>;
  churn: ReadonlyArray<SeriesPoint>;
};

export type Channel = {
  id: string;
  labelKey: string;
  value: number;
  color: string;
  share: number;
};

export type FunnelStage = {
  id: string;
  labelKey: string;
  value: number;
  pct: number;
};

export type Annotation = {
  idx: number;
  labelKey: string;
  date: string;
  subKey: string;
  color: string;
};
