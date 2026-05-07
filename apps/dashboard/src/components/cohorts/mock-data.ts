import type {
  CohortMember,
  CohortRow,
  Condition,
  CountryBreakdown,
  LtvCurve,
  SavedCohort,
  SyncDestination,
} from "./types";

export const SAVED_COHORTS: ReadonlyArray<SavedCohort> = [
  {
    id: "high_value",
    name: "High-value users",
    group: "Behavior",
    size: 4821,
    growth: "+312",
    dot: "success",
    description: "Spent >$50 lifetime · renewed ≥2x",
  },
  {
    id: "trial_users",
    name: "Trial · last 30d",
    group: "Lifecycle",
    size: 12418,
    growth: "+2,104",
    dot: "primary",
    description: "Started trial in last 30 days",
  },
  {
    id: "churn_risk",
    name: "Churn risk (30d)",
    group: "Risk",
    size: 842,
    growth: "−94",
    dot: "warning",
    description: "Active > 90d, no sessions 14d+",
  },
  {
    id: "power_users",
    name: "Power users",
    group: "Behavior",
    size: 1047,
    growth: "+38",
    dot: "violet",
    description: "10+ sessions/week · Pro Annual",
  },
  {
    id: "credits_whales",
    name: "Credits whales",
    group: "Behavior",
    size: 284,
    growth: "+12",
    dot: "warning",
    description: "Purchased 1000+ credits pack",
  },
  {
    id: "refunders",
    name: "Refunders",
    group: "Risk",
    size: 128,
    growth: "+4",
    dot: "danger",
    description: "Requested refund in last 90d",
  },
  {
    id: "ios_new",
    name: "iOS new installs",
    group: "Acquisition",
    size: 8231,
    growth: "+1,120",
    dot: "primary",
    description: "First-seen <14d · iOS",
  },
  {
    id: "android_new",
    name: "Android new installs",
    group: "Acquisition",
    size: 6418,
    growth: "+842",
    dot: "success",
    description: "First-seen <14d · Android",
  },
  {
    id: "paywall_bounce",
    name: "Paywall bouncers",
    group: "Lifecycle",
    size: 3124,
    growth: "+412",
    dot: "muted",
    description: "Saw paywall ≥3x · no purchase",
  },
];

export const COHORT_COLUMN_HEADERS = [
  "W0", "W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10", "W11",
] as const;

export const COHORT_ROWS: ReadonlyArray<CohortRow> = [
  { label: "Feb 02", size: 1842, data: [100, 62, 48, 41, 36, 33, 31, 29, 27, 26, 25, 24] },
  { label: "Feb 09", size: 1612, data: [100, 64, 51, 43, 38, 35, 32, 30, 28, 27, 25, null] },
  { label: "Feb 16", size: 1734, data: [100, 58, 45, 39, 34, 31, 28, 27, 25, 24, null, null] },
  { label: "Feb 23", size: 1921, data: [100, 66, 52, 45, 40, 36, 34, 32, 30, null, null, null] },
  { label: "Mar 02", size: 2104, data: [100, 68, 55, 47, 42, 38, 35, 33, null, null, null, null] },
  { label: "Mar 09", size: 1987, data: [100, 65, 51, 44, 39, 36, 33, null, null, null, null, null] },
  { label: "Mar 16", size: 2231, data: [100, 69, 56, 48, 43, 40, null, null, null, null, null, null] },
  { label: "Mar 23", size: 2418, data: [100, 71, 58, 51, 46, null, null, null, null, null, null, null] },
  { label: "Mar 30", size: 2604, data: [100, 72, 59, 52, null, null, null, null, null, null, null, null] },
  { label: "Apr 06", size: 2512, data: [100, 70, 57, null, null, null, null, null, null, null, null, null] },
  { label: "Apr 13", size: 2342, data: [100, 68, null, null, null, null, null, null, null, null, null, null] },
  { label: "Apr 20", size: 2104, data: [100, null, null, null, null, null, null, null, null, null, null, null] },
];

export const LTV_CURVES: ReadonlyArray<LtvCurve> = [
  { label: "Feb 02", color: "primary", points: [0, 3.2, 5.8, 7.9, 9.6, 11.1, 12.3, 13.4, 14.3, 15.1, 15.8, 16.4] },
  { label: "Feb 23", color: "violet",  points: [0, 4.1, 7.4, 10.2, 12.4, 14.3, 15.9, 17.2, 18.3, 19.2, null, null] },
  { label: "Mar 16", color: "success", points: [0, 4.8, 8.7, 12.1, 15.0, 17.4, 19.3, null, null, null, null, null] },
  { label: "Apr 06", color: "warning", points: [0, 5.4, 9.6, 13.4, null, null, null, null, null, null, null, null] },
];

export const COUNTRY_BREAKDOWN: ReadonlyArray<CountryBreakdown> = [
  { country: "United States",  users: 2104, w4: 64.8, ltv: 38.20, churn: 2.4, delta: "+12%" },
  { country: "United Kingdom", users: 841,  w4: 63.1, ltv: 34.50, churn: 2.6, delta: "+8%"  },
  { country: "Canada",         users: 612,  w4: 61.4, ltv: 31.80, churn: 2.8, delta: "+2%"  },
  { country: "Australia",      users: 487,  w4: 59.2, ltv: 29.40, churn: 3.1, delta: "−4%"  },
  { country: "Germany",        users: 312,  w4: 57.8, ltv: 26.10, churn: 3.4, delta: "−9%"  },
  { country: "Other (18)",     users: 465,  w4: 54.2, ltv: 22.80, churn: 3.8, delta: "−18%" },
];

export const SYNC_DESTINATIONS: ReadonlyArray<SyncDestination> = [
  { id: "metaAds",     status: "on",  dot: "primary", state: { kind: "syncedAgo",     ago: "6m ago" } },
  { id: "tiktokAds",   status: "off", dot: "muted",   state: { kind: "notSynced" } },
  { id: "experiments", status: "on",  dot: "violet",  state: { kind: "activeCount",   count: 2 } },
  { id: "featureFlag", status: "on",  dot: "success", state: { kind: "ruleReferences", count: 1 } },
];

export const SAMPLE_MEMBERS: ReadonlyArray<CohortMember> = [
  { id: "u_9f2a", initials: "MC", name: "Mira Chen" },
  { id: "u_b81c", initials: "JK", name: "Jordan K." },
  { id: "u_4d0e", initials: "SA", name: "S. Alvarez" },
  { id: "u_7eab", initials: "AY", name: "Ahmet Y." },
  { id: "u_2f15", initials: "PM", name: "P. Müller" },
  { id: "u_5d82", initials: "NI", name: "Naoko I." },
  { id: "u_c104", initials: "RD", name: "R. Dubois" },
];

export const INCLUDE_CONDITIONS: ReadonlyArray<Condition> = [
  { attribute: "user.lifetime_revenue", op: ">",  value: "50" },
  { attribute: "subscription.renewals", op: ">=", value: "2" },
  { attribute: "user.country",          op: "in", value: "[US, CA, GB, AU]" },
];

export const EXCLUDE_CONDITIONS: ReadonlyArray<Condition> = [
  { attribute: "event", op: "=", value: "refund_requested", trailing: { op: "within", value: "90d" } },
];

export const KPI_VALUES = {
  groupCount: 4,
  syncedCount: 2,
  avgRetentionDelta: 2.3,
  bestCohortName: "High-value",
  bestCohortValue: 62.4,
  bestCohortUsers: "4,821",
  blendedLtv: "$17.24",
  blendedLtvDelta: "1.80",
} as const;
