import type {
  ChartCatalogEntry,
  ChartCategory,
  ChartRangeOption,
  ChartType,
} from "@rovenue/shared";

// =============================================================
// System chart catalog
// =============================================================
//
// The hard-coded library of charts that ships with every
// project. These rows are read-only; the dashboard merges them
// with the project's `custom_charts` rows when rendering the
// left-rail library on /charts.
//
// `name` is a translation slug — the dashboard resolves it under
// `charts.items.<id>`. For custom charts the literal user-typed
// label is returned instead.

interface SystemChart {
  id: string;
  category: ChartCategory;
  chartType: ChartType;
  range: ChartRangeOption;
  config: Record<string, unknown>;
}

const SYSTEM_CATALOG: ReadonlyArray<SystemChart> = [
  { id: "mrr", category: "revenue", chartType: "area", range: "12M", config: {} },
  { id: "arr", category: "revenue", chartType: "line", range: "12M", config: {} },
  { id: "arpu", category: "revenue", chartType: "line", range: "12M", config: {} },
  { id: "rev_per_install", category: "revenue", chartType: "line", range: "12M", config: {} },
  { id: "gross_vs_net", category: "revenue", chartType: "area", range: "12M", config: {} },
  { id: "new_subs", category: "growth", chartType: "bar", range: "6M", config: {} },
  { id: "trials_started", category: "growth", chartType: "bar", range: "6M", config: {} },
  { id: "reactivations", category: "growth", chartType: "line", range: "6M", config: {} },
  { id: "churn", category: "retention", chartType: "line", range: "12M", config: {} },
  { id: "retention_curve", category: "retention", chartType: "line", range: "12M", config: {} },
  { id: "ltv", category: "retention", chartType: "line", range: "12M", config: {} },
  { id: "trial_to_paid", category: "conversion", chartType: "line", range: "6M", config: {} },
  { id: "paywall_view_rate", category: "conversion", chartType: "line", range: "6M", config: {} },
  { id: "paywall_purchase", category: "conversion", chartType: "line", range: "6M", config: {} },
  { id: "credit_burn", category: "credits", chartType: "area", range: "6M", config: {} },
  { id: "liability", category: "credits", chartType: "line", range: "12M", config: {} },
];

export const SYSTEM_CHART_IDS: ReadonlySet<string> = new Set(
  SYSTEM_CATALOG.map((c) => c.id),
);

export function listSystemChartEntries(): ChartCatalogEntry[] {
  return SYSTEM_CATALOG.map((c) => ({
    id: c.id,
    kind: "system",
    category: c.category,
    // For system entries we return the translation slug; the
    // dashboard resolves it via i18n (`charts.items.<id>`).
    name: c.id,
    chartType: c.chartType,
    range: c.range,
    config: c.config,
    createdAt: null,
    updatedAt: null,
  }));
}

export function isSystemChartId(id: string): boolean {
  return SYSTEM_CHART_IDS.has(id);
}
