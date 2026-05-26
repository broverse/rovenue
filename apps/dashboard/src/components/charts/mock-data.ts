import { seededSeries } from "./format";
import type {
  Annotation,
  Channel,
  FunnelStage,
  GroupBy,
  MrrSeries,
  SavedView,
} from "./types";

export const CHART_MONTH_LABELS = [
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
] as const;

export const MRR_SERIES: MrrSeries = {
  current: seededSeries(0, 38_000, 0.062, 1500),
  prev: seededSeries(7, 32_000, 0.045, 1200),
  newMrr: seededSeries(2, 6_800, 0.05, 600),
  expansion: seededSeries(4, 2_400, 0.06, 300),
  contraction: seededSeries(6, -1100, 0.04, 220).map((v) => -Math.abs(v)),
  churn: seededSeries(9, -3200, 0.03, 400).map((v) => -Math.abs(v)),
};

export const CHANNELS: ReadonlyArray<Channel> = [
  {
    id: "organic",
    labelKey: "charts.channels.organic",
    value: 38_120,
    color: "var(--color-rv-accent-500)",
    share: 47,
  },
  {
    id: "asa",
    labelKey: "charts.channels.asa",
    value: 22_480,
    color: "var(--color-rv-violet)",
    share: 28,
  },
  {
    id: "meta",
    labelKey: "charts.channels.meta",
    value: 12_940,
    color: "var(--color-rv-success)",
    share: 16,
  },
  {
    id: "tiktok",
    labelKey: "charts.channels.tiktok",
    value: 5_410,
    color: "var(--color-rv-warning)",
    share: 7,
  },
  {
    id: "referral",
    labelKey: "charts.channels.referral",
    value: 1_820,
    color: "var(--color-rv-cyan)",
    share: 2,
  },
];

export const FUNNEL_STAGES: ReadonlyArray<FunnelStage> = [
  { id: "install", labelKey: "charts.funnel.install", value: 124_800, pct: 100 },
  { id: "onboarding", labelKey: "charts.funnel.onboarding", value: 78_320, pct: 62.8 },
  { id: "paywall", labelKey: "charts.funnel.paywall", value: 71_840, pct: 57.6 },
  { id: "trial", labelKey: "charts.funnel.trial", value: 18_420, pct: 14.8 },
  { id: "paid", labelKey: "charts.funnel.paid", value: 7_104, pct: 5.7 },
];

export const ANNOTATIONS: ReadonlyArray<Annotation> = [
  {
    idx: 2,
    labelKey: "charts.annotations.v31.label",
    date: "Aug 14",
    subKey: "charts.annotations.v31.sub",
    color: "var(--color-rv-success)",
  },
  {
    idx: 5,
    labelKey: "charts.annotations.holiday.label",
    date: "Nov 22",
    subKey: "charts.annotations.holiday.sub",
    color: "var(--color-rv-warning)",
  },
  {
    idx: 8,
    labelKey: "charts.annotations.pricing.label",
    date: "Feb 8",
    subKey: "charts.annotations.pricing.sub",
    color: "var(--color-rv-accent-500)",
  },
  {
    idx: 10,
    labelKey: "charts.annotations.refund.label",
    date: "Apr 1",
    subKey: "charts.annotations.refund.sub",
    color: "var(--color-rv-danger)",
  },
];

export const HEATMAP_MATRIX: ReadonlyArray<ReadonlyArray<number>> = (() => {
  const arr: number[][] = [];
  for (let d = 0; d < 7; d++) {
    const row: number[] = [];
    for (let h = 0; h < 24; h++) {
      const peak =
        Math.exp(-Math.pow((h - 19) / 4.5, 2)) * 0.7 +
        Math.exp(-Math.pow((h - 12) / 3, 2)) * 0.4;
      const weekend = d === 5 || d === 6 ? 1.15 : 1.0;
      const noise = ((Math.sin((d + 1) * 7.13 + h * 1.21) + 1) / 2) * 0.15;
      row.push(Math.min(1, peak * weekend + noise));
    }
    arr.push(row);
  }
  return arr;
})();

export const HEATMAP_DAY_KEYS = [
  "charts.days.mon",
  "charts.days.tue",
  "charts.days.wed",
  "charts.days.thu",
  "charts.days.fri",
  "charts.days.sat",
  "charts.days.sun",
] as const;

export const GROUP_BY_OPTIONS: ReadonlyArray<GroupBy> = [
  "none",
  "platform",
  "country",
  "product",
  "channel",
  "cohort_month",
];

export const SAVED_VIEWS: ReadonlyArray<SavedView> = [
  {
    id: "ios_only",
    nameKey: "charts.savedViews.iosOnly.name",
    metaKey: "charts.savedViews.iosOnly.meta",
  },
  {
    id: "annual",
    nameKey: "charts.savedViews.annual.name",
    metaKey: "charts.savedViews.annual.meta",
  },
  {
    id: "top_countries",
    nameKey: "charts.savedViews.topCountries.name",
    metaKey: "charts.savedViews.topCountries.meta",
  },
];

export const SQL_PREVIEW = `SELECT
  date_trunc('month', created_at)
    AS month,
  SUM(amount) AS mrr
FROM subscription_charges
WHERE platform IN ('ios','android')
  AND product_group_id IN (
    'premium', 'pro'
  )
GROUP BY 1
ORDER BY 1;`;
