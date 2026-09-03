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
// label is returned instead. An id with no `charts.items.<id>` string
// renders as the raw key in the rail, so a new entry here is not
// finished until en.json has its label.
//
// Selecting an entry renders the `/series/:chartId` panel, and every id
// here has a `readChartSeries` reader — charts.catalog-coverage.test.ts
// fails by name if one is added without. Fourteen are daily series; two
// (`retention_curve`, `ltv`) are cohort-period curves and say so via the
// response's `axis`. "Not wired to a data source" is now reachable only
// for an id the dispatcher does not know.
//
// `estimated_proceeds` is deliberately NOT in this list, because it is
// not that: it is a per-store breakdown whose whole point is showing a
// store with a configured commission rate beside one without, which a
// single blended daily line cannot express (see proceeds.ts and
// charts.ts's readProceeds comment). It has its own reader and its own
// always-visible `ProceedsCard`. Listing it here told users the figure
// was unavailable while it sat two panels away — and, with no
// `charts.items.estimated_proceeds` string, the rail rendered the raw
// i18n key. An entry that can never be dispatched does not belong in
// the dispatcher's catalog.

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
  // Net revenue ÷ installs. "Install" means one thing only, defined in
  // services/metrics/installs.ts: a subscriber row created by the SDK's
  // public-key /v1 surface (`subscribers.sdkInstalledAt`). Importer- and
  // webhook-created rows are not installs and are not counted.
  { id: "rev_per_install", category: "revenue", chartType: "line", range: "12M", config: {} },
  { id: "gross_vs_net", category: "revenue", chartType: "area", range: "12M", config: {} },
  { id: "new_subs", category: "growth", chartType: "bar", range: "6M", config: {} },
  { id: "trials_started", category: "growth", chartType: "bar", range: "6M", config: {} },
  { id: "reactivations", category: "growth", chartType: "line", range: "6M", config: {} },
  { id: "churn", category: "retention", chartType: "line", range: "12M", config: {} },
  // PERIOD axis, not a date one: `computeRetention` (services/cohorts.ts)
  // yields points indexed by periods since cohort start. `chartType:
  // "line"` is accurate — it is a line, over periods — and the response
  // says which via `ChartSeriesAxis` (@rovenue/shared). It was
  // unsupported until 2026-09-04 only because that discriminator did not
  // exist; the catalog id and its declared type never changed.
  { id: "retention_curve", category: "retention", chartType: "line", range: "12M", config: {} },
  // PERIOD axis too, and the same fixed cohort as `retention_curve` so
  // the two panels describe one population. Cumulative net revenue per
  // cohort member at each period — `computeCohortLtvCurve`, not
  // `v_revenue_lifetime_subscriber`, which groups by (projectId,
  // subscriberId) and has no day dimension to widen by at all.
  { id: "ltv", category: "retention", chartType: "line", range: "12M", config: {} },
  { id: "trial_to_paid", category: "conversion", chartType: "line", range: "6M", config: {} },
  { id: "paywall_view_rate", category: "conversion", chartType: "line", range: "6M", config: {} },
  { id: "paywall_purchase", category: "conversion", chartType: "line", range: "6M", config: {} },
  { id: "credit_burn", category: "credits", chartType: "area", range: "6M", config: {} },
  // Daily outstanding credit balance, from `getCreditLiabilityDaily`
  // (services/metrics/credits.ts). Ruled unbuildable on 2026-09-03 for
  // want of balance history; `credit_ledger` had it all along —
  // append-only, every row carrying the signed delta AND the balance
  // after it. The series is anchored on today's authoritative figure and
  // walked backwards, so its last point IS the number /credits shows.
  // Credits, not USD: the rollup's paid-reserve figure needs a
  // window-derived average credit price and has no historical meaning.
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
