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
// Selecting an entry renders the `/series/:chartId` panel. Most ids
// here have no `readChartSeries` reader YET and show "not wired to a
// data source" until one lands (ROADMAP §5 tracks that) — that is a
// pending state, not a wrong one, because every id in this list is a
// daily series the dispatcher will eventually serve.
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
  { id: "rev_per_install", category: "revenue", chartType: "line", range: "12M", config: {} },
  { id: "gross_vs_net", category: "revenue", chartType: "area", range: "12M", config: {} },
  { id: "new_subs", category: "growth", chartType: "bar", range: "6M", config: {} },
  { id: "trials_started", category: "growth", chartType: "bar", range: "6M", config: {} },
  { id: "reactivations", category: "growth", chartType: "line", range: "6M", config: {} },
  { id: "churn", category: "retention", chartType: "line", range: "12M", config: {} },
  // NOT wired (task 4, controller Ruling 4 — do not wire, do not change
  // this id or its chartType, that's Task 8's job). `computeRetention`
  // (services/cohorts.ts) produces a cohort × period-since-join matrix;
  // its x-axis is periods since cohort start (0, 7, 30…), not a
  // calendar date. `ChartSeriesPoint.bucket` is documented as an ISO
  // calendar date (dashboard.ts:877-879), so this declared
  // `chartType: "line"` does not describe this metric — forcing the
  // matrix into a daily-bucket line would fabricate dates. `/cohorts`
  // already renders the real matrix correctly as a heatmap; that is
  // this metric's surface, not `/series/:chartId`.
  { id: "retention_curve", category: "retention", chartType: "line", range: "12M", config: {} },
  // NOT wired (task 4): every owning service was checked for a day
  // column and none has one. `getLtvDistribution` (ltv.ts) and
  // `getRevenueSummary.avgLtvUsd` both read
  // `v_revenue_lifetime_subscriber`, a lifetime-to-date snapshot per
  // subscriber with no `eventDate` — there is no day to widen by.
  // `getLtvPrediction` (ltv-prediction.ts/ltv-extrapolation.ts) is
  // cohort-MONTH based and otherwise returns one blended scalar,
  // neither of which is a daily series either. See charts.ts's
  // dispatcher-header comment for the full reasoning.
  { id: "ltv", category: "retention", chartType: "line", range: "12M", config: {} },
  { id: "trial_to_paid", category: "conversion", chartType: "line", range: "6M", config: {} },
  { id: "paywall_view_rate", category: "conversion", chartType: "line", range: "6M", config: {} },
  { id: "paywall_purchase", category: "conversion", chartType: "line", range: "6M", config: {} },
  { id: "credit_burn", category: "credits", chartType: "area", range: "6M", config: {} },
  // NOT wired (task 5, controller Ruling 3 — see task-5-report.md).
  // `readLiability` (services/metrics/credits.ts) sums the LATEST
  // per-subscriber balances straight from Postgres — a present-day
  // snapshot, not a dated event log — and no balance-history table
  // exists anywhere to derive a trend from. A 12-month line here would
  // have to be either today's single figure repeated across every
  // bucket or a reconstruction from credit_ledger that no service
  // owns; both are fabricated data, not a measured series. `/credits`
  // already shows the real, current liability figure (and its
  // paid/promo/transfer composition) via `getCreditsRollup` — that is
  // this metric's honest surface. Left `chartType: "line"` and the id
  // itself untouched: reconciling the catalog's declared shape with
  // what the data model can actually support is Task 8's job, not
  // this reader's.
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
