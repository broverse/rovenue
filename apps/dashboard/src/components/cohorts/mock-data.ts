import type {
  CohortMember,
  Condition,
  CountryBreakdown,
  LtvCurve,
  SyncDestination,
} from "./types";

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
  blendedLtv: "$17.24",
  blendedLtvDelta: "1.80",
} as const;
