import type { CohortMember, Condition } from "./types";

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
